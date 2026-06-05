/**
 * Rebuilds model message array from Plan state each turn (renderer) — v50.
 */
(function (global) {
    // Code tokenizes denser than prose (~2.0–2.8 chars/token for source). The old
    // 3.5 over-filled the prompt, so the server silently truncated from the FRONT —
    // dropping message 0 (the plan digest the design promises to protect). 2.5 is a
    // conservative estimate that keeps the assembled prompt inside num_ctx.
    const CHARS_PER_TOKEN = 2.5;

    function estimateChars(tokens) {
        return Math.floor(tokens * CHARS_PER_TOKEN);
    }

    // Number every line so the model can address "line 42" and build accurate
    // edit_file find-blocks. Returns { text, lineCount }.
    function numberLines(content) {
        const lines = content.split('\n');
        const width = String(lines.length).length;
        const text = lines.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join('\n');
        return { text, lineCount: lines.length };
    }

    // Clamp long text while preserving its END — test failures, stack traces and
    // error lines live at the tail, so head-only truncation hid the very thing the
    // model needs to act on.
    function clampKeepingTail(text, max) {
        if (!text || text.length <= max) return text;
        const head = Math.floor(max * 0.35);
        const tail = max - head - 30;
        return text.slice(0, head) + '\n...[output truncated]...\n' + text.slice(-tail);
    }

    function detectModelFamily(model) {
        const m = String(model || '').toLowerCase();
        if (/qwen/.test(m)) return 'qwen';
        if (/deepseek/.test(m)) return 'deepseek';
        if (/llama|meta-llama|mistral|mixtral|gemma|phi|codellama|starcoder|granite|falcon/.test(m)) return 'llama';
        return 'default';
    }

    function getFamilyPrompt(family) {
        switch (family) {
            case 'qwen':
                return 'STYLE: One tool per step. read_file before edit_file. run_verify or run_shell_command after changes. Do not narrate plans you have not executed.';
            case 'deepseek':
                return 'STYLE: One tool per step. read_file before edit_file. run_shell_command for git/build/test. Verify before mark_step_done.';
            case 'llama':
                return 'STYLE: One tool per step. read_file before edit_file. run_shell_command for git/build/test. Verify before mark_step_done.';
            default:
                return '';
        }
    }

    function buildPlanDigest(plan, currentStep) {
        const lines = [];
        lines.push(`GOAL: ${plan.goal}`);
        if (plan.projectRoot) lines.push(`PROJECT ROOT: ${plan.projectRoot}`);
        if (plan.projectType) lines.push(`PROJECT TYPE: ${plan.projectType}`);
        if (plan.testCmd) lines.push(`TEST CMD: ${plan.testCmd}`);
        if (plan.lintCmd) lines.push(`LINT CMD: ${plan.lintCmd}`);
        if (plan.activeFiles?.length) lines.push(`ACTIVE FILES: ${plan.activeFiles.join(', ')}`);
        if (plan.decisions?.length) {
            lines.push('DECISIONS:');
            plan.decisions.forEach(d => lines.push(`- ${d}`));
        }
        lines.push('STEPS:');
        plan.steps.forEach(s => {
            const mark = s.status === 'done' ? '[x]' : s.status === 'active' ? '[>]' : s.status === 'failed' ? '[!]' : '[ ]';
            const verified = s.verifiedAt ? ' [verified]' : '';
            lines.push(`${mark} ${s.id}. ${s.title}${s.result ? ` — ${s.result}` : ''}${verified}`);
        });
        if (currentStep) {
            lines.push('');
            lines.push(`CURRENT STEP (${currentStep.id}): ${currentStep.title}`);
            if (/inspect|identify|audit|discover|review.*structure|missing.*file|existing.*(package|structure)/i.test(currentStep.title)) {
                lines.push('INSPECT STEP: Use list_project/read_file/glob once, summarize findings, then call mark_step_done. Do not repeat the same listing.');
            }
            if (/implement|create|build|write|add|fix|scaffold|setup/i.test(currentStep.title)) {
                lines.push('IMPLEMENT STEP: read_file the target file first, then edit_file (small diff) or write_file for new files. Run the code or run_verify before mark_step_done.');
            }
            if (!currentStep.verifiedAt && plan.verifyPolicy !== 'off') {
                lines.push('VERIFY: Step must pass lint/test before mark_step_done.');
            }
            if (currentStep.filesTouched?.length) {
                lines.push(`Files for this step: ${currentStep.filesTouched.join(', ')}`);
            }
        }
        if (plan.scratchpad?.trim()) {
            lines.push('');
            lines.push('SCRATCHPAD:');
            lines.push(plan.scratchpad.trim().slice(-3000));
        }
        return lines.join('\n');
    }

    // OpenAI-compatible servers require every role:'tool' message to be preceded by
    // an assistant message whose tool_calls contains the matching id. Budget trimming
    // and slice(-N) of recent turns can orphan a tool message at the head of the slice,
    // which strict servers (and the spec) reject. Drop any tool message that lacks a
    // visible parent tool_call within the same slice.
    function sanitizeTurns(turns) {
        const known = new Set();
        const out = [];
        for (const t of turns) {
            if (t.role === 'assistant' && Array.isArray(t.tool_calls)) {
                t.tool_calls.forEach(tc => { if (tc && tc.id) known.add(tc.id); });
                out.push(t);
            } else if (t.role === 'tool') {
                if (t.tool_call_id && known.has(t.tool_call_id)) out.push(t);
                // else: orphaned tool result — drop it
            } else {
                out.push(t);
            }
        }
        // Never lead with a tool message even if its id somehow slipped through.
        while (out.length && out[0].role === 'tool') out.shift();
        return out;
    }

    // Return the file with line numbers. When it doesn't fit, keep a CONTIGUOUS
    // numbered head of whole lines and state exactly which line range was omitted —
    // never head+tail (which dropped the middle, where the edited code usually is,
    // while looking complete to the model).
    async function readFileExcerpt(api, filepath, maxChars) {
        const res = await api.invoke('agent-read-file', filepath);
        if (res.error) return `[Could not read ${filepath}: ${res.error}]`;
        const content = res.content || '';
        const { text, lineCount } = numberLines(content);
        if (text.length <= maxChars) return text;

        const numbered = text.split('\n');
        const kept = [];
        let used = 0;
        for (let i = 0; i < numbered.length; i++) {
            if (used + numbered[i].length + 1 > maxChars) break;
            kept.push(numbered[i]);
            used += numbered[i].length + 1;
        }
        const shownTo = kept.length;
        return kept.join('\n') +
            `\n... [lines ${shownTo + 1}–${lineCount} of ${lineCount} omitted — use read_file with start/end to view] ...`;
    }

    async function buildExecutionContext(options) {
        const {
            api,
            plan,
            currentStep,
            numCtx,
            recentTurns = [],
            memorySnippets = [],
            envContext = '',
            lastToolReceipt = '',
            chatHistory = [],
            shell = '',
            model = ''
        } = options;

        const promptBudget = estimateChars(Math.floor(numCtx * 0.62));
        let used = 0;

        const shellLine = shell === 'powershell'
            ? 'SHELL: run_shell_command runs in PowerShell on Windows. Use PowerShell syntax (Get-ChildItem, Remove-Item, `;` to chain; NOT ls/rm/&&/sudo).'
            : shell === 'bash'
                ? 'SHELL: run_shell_command runs in bash. Use POSIX syntax.'
                : 'SHELL: run_shell_command runs in the host shell (PowerShell on Windows, bash on macOS/Linux). Use the correct syntax for that shell.';

        const familyLine = getFamilyPrompt(detectModelFamily(model));

        const systemParts = [
            'You are Xkaliber Agent, a local-first coding agent. Work the CURRENT STEP only; call mark_step_done when it is genuinely complete.',
            familyLine,
            'HOW TO WORK:',
            '(1) READ a file with read_file BEFORE editing — never write_file over a file you have not read.',
            '(2) Smallest reasonable change — no drive-by refactors or features the user did not ask for.',
            '(3) Write COMPLETE, working code — no placeholders, no "// TODO later", no partial snippets.',
            '(4) Match the existing file\'s style, imports, and conventions.',
            '(5) VERIFY before mark_step_done — run run_verify or run_shell_command and read the output; do not assume it works.',
            '(6) Diagnose before retrying — if a tool or verify fails, read the error, identify the cause, adjust; do not repeat the identical edit.',
            '(7) Faithful reporting — if something failed, say so and quote the relevant error.',
            'PROJECT FILES are shown with a line-number prefix ("42\\t...") purely for reference. When you write an edit_file find/replace block, use the real code only — do NOT include the leading line number or the tab.',
            'Make progress every turn with a tool call rather than prose; if the step is verified and complete, call mark_step_done; if truly stuck, mark_step_blocked with a reason.',
            shellLine,
            envContext
        ].filter(Boolean).join('\n');

        const digest = buildPlanDigest(plan, currentStep);
        const systemContent = systemParts + '\n\n--- PLAN ---\n' + digest;
        used += systemContent.length;

        const messages = [
            { role: 'system', content: systemContent }
        ];

        // Include a few relevant messages from chat history to maintain continuity
        if (chatHistory && chatHistory.length > 0) {
            const relevantChat = chatHistory.filter(m => m.role !== 'system').slice(-4);
            relevantChat.forEach(m => {
                const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                messages.push({ role: m.role, content: contentStr });
                used += contentStr.length;
            });
        }

        try {
            const mapRes = await api.invoke('agent-get-repo-map', {
                boostTerms: [plan.goal, currentStep?.title || ''].join(' ').split(/\s+/).slice(0, 20),
                maxTokens: 1200
            });
            if (mapRes.map) {
                const block = '[REPO MAP]\n' + mapRes.map;
                messages.push({ role: 'user', content: block });
                used += block.length;
            }
        } catch (e) { /* optional */ }

        // Files the agent is editing must be shown in full whenever they fit the
        // budget — head/tail truncation forces blind mid-file edits. Give the file
        // section a larger share of the prompt and a high per-file cap; only files
        // that genuinely overflow the remaining budget fall back to head/tail.
        const activePaths = [...(plan.activeFiles || [])];
        const fileBudget = Math.max(4000, Math.floor(promptBudget * 0.5));
        const ACTIVE_FILE_CAP = 20000;
        const LEDGER_FILE_CAP = 6000;
        let fileCharsUsed = 0;
        const fileBlocks = [];

        for (const fp of activePaths) {
            if (fileCharsUsed >= fileBudget) break;
            const excerpt = await readFileExcerpt(api, fp, Math.min(ACTIVE_FILE_CAP, fileBudget - fileCharsUsed));
            fileBlocks.push(`--- ACTIVE FILE: ${fp} ---\n${excerpt}`);
            fileCharsUsed += excerpt.length;
        }

        // The current step's touched files are also being worked on — prefer them
        // (full content) ahead of the broader ledger tail.
        const ledgerPaths = new Set(currentStep?.filesTouched || []);
        Object.keys(plan.filesLedger || {}).slice(-6).forEach(p => ledgerPaths.add(p));
        for (const fp of ledgerPaths) {
            if (fileCharsUsed >= fileBudget || activePaths.includes(fp)) continue;
            const isStepFile = (currentStep?.filesTouched || []).includes(fp);
            const cap = isStepFile ? ACTIVE_FILE_CAP : LEDGER_FILE_CAP;
            const excerpt = await readFileExcerpt(api, fp, Math.min(cap, fileBudget - fileCharsUsed));
            fileBlocks.push(`--- FILE: ${fp} ---\n${excerpt}`);
            fileCharsUsed += excerpt.length;
        }

        if (fileBlocks.length) {
            const filesContent = '[PROJECT FILES]\n' + fileBlocks.join('\n\n');
            messages.push({ role: 'user', content: filesContent });
            used += filesContent.length; // account the exact string pushed (was undercounting separators)
        }

        if (lastToolReceipt) {
            const receiptContent = '[LAST TOOL OUTPUT]\n' + clampKeepingTail(lastToolReceipt, 8000);
            messages.push({ role: 'user', content: receiptContent });
            used += receiptContent.length; // account the clamped string, not the raw receipt
        }

        let turnsBudget = Math.max(0, promptBudget - used);
        const turnsToInclude = [];
        for (let i = recentTurns.length - 1; i >= 0 && turnsBudget > 0; i--) {
            const t = recentTurns[i];
            const len = JSON.stringify(t).length;
            if (len > turnsBudget && turnsToInclude.length >= 2) break;
            turnsToInclude.unshift(t);
            turnsBudget -= len;
        }
        sanitizeTurns(turnsToInclude).forEach(m => messages.push(m));

        if (memorySnippets.length && turnsBudget > 400) {
            const memText = memorySnippets.map(m => `- ${m.text}`).join('\n');
            messages.push({ role: 'user', content: '[LONG-TERM MEMORY]\n' + memText.slice(0, turnsBudget) });
        }

        // Hard fit-check: incremental accounting drifts, and a single oversized turn
        // can blow the budget. Trim from the END (least-critical: memory, then turns,
        // then receipt/files) until the assembled prompt fits — but NEVER drop
        // message 0 (system + plan digest), which the durable design must preserve.
        return fitMessages(messages, promptBudget);
    }

    // Drop trailing messages until total content length <= budget. message[0]
    // (system + digest) is always kept, even if it alone exceeds the budget.
    function fitMessages(messages, budget) {
        const total = (msgs) => msgs.reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
        while (messages.length > 1 && total(messages) > budget) {
            messages.pop();
        }
        return sanitizeTurns(messages);
    }

    async function buildPlanningContext(options) {
        const { api, userGoal, numCtx, memorySnippets = [], envContext = '', plan, chatHistory = [] } = options;

        let mapBlock = '';
        try {
            const mapRes = await api.invoke('agent-get-repo-map', { maxTokens: 1500 });
            mapBlock = mapRes.map || '';
        } catch (e) { /* skip */ }

        const det = await api.invoke('plan-detect').catch(() => ({}));
        const digest = plan ? buildPlanDigest(plan) : '';

        const system = [
            'You are Xkaliber Agent planner. READ-ONLY phase: do not write or edit files.',
            'Call submit_plan with goal, projectType (greenfield|brownfield), and ordered step titles.',
            'You may use grep_project, glob_files, get_repo_map, read_file, list_project, search_memory.',
            'Maintain context from the conversation history below.',
            envContext
        ].join('\n');

        const messages = [{ role: 'system', content: system }];

        // Include recent conversation for planning context
        if (chatHistory && chatHistory.length > 0) {
            chatHistory.filter(m => m.role !== 'system').slice(-6).forEach(m => {
                const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                messages.push({ role: m.role, content: contentStr });
            });
        }

        let content = `NEW TASK:\n${userGoal}\n`;
        if (digest) {
            content += `\n[EXISTING PLAN STATUS]\n${digest}\n`;
            content += `\nIf updating the plan, ensure you include all relevant existing steps that are not yet complete, or adjust them as needed based on the new task.`;
        }
        if (det.testCmd) content += `\nDetected test: ${det.testCmd}\n`;
        if (mapBlock) content += `\n[REPO MAP]\n${mapBlock}\n`;
        if (memorySnippets.length) {
            content += '\nRELEVANT MEMORY:\n' + memorySnippets.map(m => `- ${m.text}`).join('\n');
        }

        messages.push({ role: 'user', content });
        return messages;
    }

    global.XKContextBuilder = {
        buildExecutionContext,
        buildPlanningContext,
        buildPlanDigest,
        estimateChars,
        sanitizeTurns,
        numberLines,
        readFileExcerpt,
        fitMessages,
        detectModelFamily,
        getFamilyPrompt
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.XKContextBuilder;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
