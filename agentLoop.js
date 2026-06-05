/**
 * Plan-driven agent loop (renderer). Replaces monolithic sendMessage agent path.
 */
(function (global) {
    // Normalize an API base so endpoint construction is robust whether the user
    // entered "host:1234", "host:1234/", "host:1234/v1", or an Ollama "host:11434/api".
    function apiBase(base) {
        return String(base || '').trim().replace(/\/+$/, '').replace(/\/(v1|api)$/, '');
    }

    // The agent loop runs in the Electron renderer; detect the host OS so we can tell
    // the model the real shell and avoid bash-only assumptions (e.g. the sudo rewrite).
    const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '');
    const HOST_SHELL = IS_WINDOWS ? 'powershell' : 'bash';

    function formatRepairBlock(output) {
        const hints = (typeof window !== 'undefined' && window.XKRepairHints)
            || (typeof global !== 'undefined' && global.XKRepairHints);
        if (hints) return hints.formatRepairBlock(output);
        try {
            return require(require('path').join(__dirname, 'lib', 'repairHints.js')).formatRepairBlock(output);
        } catch (e) { /* renderer loads lib/repairHints.js via script tag */ }
        return '';
    }

    const PLAN_TOOLS = [
        {
            type: 'function',
            function: {
                name: 'submit_plan',
                description: 'Submit a multi-step plan for user approval. Call once with goal and step titles.',
                parameters: {
                    type: 'object',
                    properties: {
                        goal: { type: 'string' },
                        steps: { type: 'array', items: { type: 'string' } },
                        projectType: { type: 'string', enum: ['greenfield', 'brownfield'] }
                    },
                    required: ['goal', 'steps']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mark_step_done',
                description: 'Mark the current step complete with a short factual result.',
                parameters: {
                    type: 'object',
                    properties: { result: { type: 'string' } },
                    required: ['result']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'mark_step_blocked',
                description: 'Mark current step blocked with reason.',
                parameters: {
                    type: 'object',
                    properties: { reason: { type: 'string' } },
                    required: ['reason']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'run_shell_command',
                description: "Execute a command in the project's shell (PowerShell on Windows, bash on macOS/Linux) — use the correct syntax for that shell. USE THIS to check state, run scripts, build, or test. On macOS/Linux, sudo is auto-filled if a password is set in the sidebar. For long-running tasks (servers/watchers), set is_background to true.",
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' },
                        is_background: { type: 'boolean' }
                    },
                    required: ['command']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read a file from the host system.',
                parameters: {
                    type: 'object',
                    properties: {
                        filepath: { type: 'string' },
                        start: { type: 'number' },
                        end: { type: 'number' }
                    },
                    required: ['filepath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'write_file',
                description: 'Write content to a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        filepath: { type: 'string' },
                        content: { type: 'string' }
                    },
                    required: ['filepath', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'edit_file',
                description: 'Search/replace edit in a file (requires active build plan).',
                parameters: {
                    type: 'object',
                    properties: {
                        filepath: { type: 'string' },
                        find: { type: 'string' },
                        replace: { type: 'string' }
                    },
                    required: ['filepath', 'find', 'replace']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_directory',
                description: 'List contents of a directory.',
                parameters: {
                    type: 'object',
                    properties: {
                        dirpath: { type: 'string' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_project',
                description: 'List project directory tree under project root.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'delete_file',
                description: 'Delete a file or directory from the host system.',
                parameters: {
                    type: 'object',
                    properties: { filepath: { type: 'string' } },
                    required: ['filepath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'set_project_root',
                description: 'Set working project root to an existing directory path.',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'memory_search',
                description: 'Search long-term vector memory to recall past learned knowledge, user preferences, or facts.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'save_new_user_fact_only',
                description: 'Saves a permanent fact to memory. EXTREMELY SELECTIVE.',
                parameters: {
                    type: 'object',
                    properties: { exact_new_fact: { type: 'string' } },
                    required: ['exact_new_fact']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_process_log',
                description: 'Read the output log of a background process.',
                parameters: {
                    type: 'object',
                    properties: {
                        job_id: { type: 'string' },
                        lines: { type: 'number' }
                    },
                    required: ['job_id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'send_input',
                description: 'Send standard input (like \'Y\' or a password) to an active background process.',
                parameters: {
                    type: 'object',
                    properties: {
                        job_id: { type: 'string' },
                        input: { type: 'string' }
                    },
                    required: ['job_id', 'input']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'provide_file_download_link',
                description: 'Provide the user with a direct download link to a file on the host system.',
                parameters: {
                    type: 'object',
                    properties: {
                        filepath: { type: 'string' }
                    },
                    required: ['filepath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'web_search',
                description: 'Search the web for information.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'send_whatsapp_message',
                description: 'Send a WhatsApp message.',
                parameters: {
                    type: 'object',
                    properties: {
                        number: { type: 'string' },
                        message: { type: 'string' }
                    },
                    required: ['number', 'message']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'dynamic_schema_generate',
                description: 'Generate a dynamic JSON schema for a task.',
                parameters: {
                    type: 'object',
                    properties: {
                        task: { type: 'string' },
                        fields: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['task', 'fields']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'grep_project',
                description: 'Search file contents in the project (ripgrep or fallback).',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string' },
                        path: { type: 'string' },
                        glob: { type: 'string' },
                        case_insensitive: { type: 'boolean' }
                    },
                    required: ['pattern']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'glob_files',
                description: 'Find files by glob pattern under project root.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string' },
                        path: { type: 'string' }
                    },
                    required: ['pattern']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_repo_map',
                description: 'Get token-budgeted codebase map (structure + symbols).',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_patch',
                description: 'Apply unified diff patch to a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        filepath: { type: 'string' },
                        patch: { type: 'string' }
                    },
                    required: ['filepath', 'patch']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_edits',
                description: 'Apply multiple search/replace edits in one call.',
                parameters: {
                    type: 'object',
                    properties: {
                        edits: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    filepath: { type: 'string' },
                                    find: { type: 'string' },
                                    replace: { type: 'string' }
                                }
                            }
                        }
                    },
                    required: ['edits']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'add_files',
                description: 'Add files to active context (full content injected each turn).',
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['paths']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'drop_files',
                description: 'Remove files from active context.',
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['paths']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'run_verify',
                description: 'Run lint and test commands for the project. Required before mark_step_done.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'record_decision',
                description: 'Record an architectural or approach decision on the plan.',
                parameters: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'init_project',
                description: 'Initialize git repo and run scaffold command (user-confirmed in UI for destructive ops).',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' },
                        project_type: { type: 'string', enum: ['greenfield', 'brownfield'] }
                    },
                    required: ['command']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'add_steps',
                description: 'Append new step(s) to the current plan when you discover work that was not in the original plan (e.g. a missing config, migration, or refactor). The steps appear in the plan and are executed after the current ones.',
                parameters: {
                    type: 'object',
                    properties: { steps: { type: 'array', items: { type: 'string' } } },
                    required: ['steps']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'fetch_url',
                description: 'Fetch a web page or API URL and return its readable text content. USE THIS to read documentation, API references, or files when a web_search snippet is not enough. Returns text (HTML is stripped).',
                parameters: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_processes',
                description: 'List background processes started with run_shell_command (is_background:true), with their running state and exit code.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'stop_process',
                description: 'Kill a background process by its job id (from list_processes / read_process_log). Use to stop a dev server or watcher when done.',
                parameters: {
                    type: 'object',
                    properties: { job_id: { type: 'number' } },
                    required: ['job_id']
                }
            }
        }
    ];

    const READ_ONLY_TOOLS = new Set([
        'grep_project', 'glob_files', 'get_repo_map', 'read_file', 'list_project', 'list_directory',
        'search_memory', 'memory_search', 'read_process_log', 'web_search', 'run_verify', 'plan-detect',
        'fetch_url', 'list_processes'
    ]);

    const PLANNING_TOOLS = new Set([
        'submit_plan', 'search_memory', 'memory_search', 'list_project', 'list_directory', 'grep_project', 'glob_files',
        'get_repo_map', 'read_file', 'add_files', 'fetch_url'
    ]);

    // Build Mode = CODING TOOLS ONLY. Non-coding tools are removed from the execution
    // toolset so a small model isn't distracted into messaging/download/schema actions
    // during a build. (web_search + fetch_url stay — looking up docs is part of coding;
    // memory_search stays — recalling project context helps.) submit_plan is also
    // excluded: it recreates the plan (currentStepId -> null) and strands the build —
    // the model grows the plan with add_steps instead, and the handler refuses a
    // re-submit while executing (covers the text tool-call fallback).
    const EXECUTION_EXCLUDED_TOOLS = new Set([
        'submit_plan',
        'send_whatsapp_message',
        'provide_file_download_link',
        'dynamic_schema_generate',
        'save_new_user_fact_only',
    ]);
    const EXECUTION_TOOLS = PLAN_TOOLS.filter(t => !EXECUTION_EXCLUDED_TOOLS.has(t.function.name));

    function toolNames() {
        return PLAN_TOOLS.map(t => t.function.name);
    }

    // --- Text-based tool-call fallback ----------------------------------------
    // Small local models (e.g. Gemma 3n E4B) frequently emit tool calls as plain
    // text/JSON instead of the OpenAI-native `tool_calls` field. Without this the
    // agent loop sees zero tool calls and stalls. We tolerantly extract calls from
    // content and only accept ones whose name is a real tool, to avoid misfiring
    // on prose that merely contains JSON.
    function scanJsonObjects(text) {
        // Return substrings that look like balanced top-level {...} or [...] JSON.
        const out = [];
        const opens = { '{': '}', '[': ']' };
        for (let i = 0; i < text.length; i++) {
            const open = text[i];
            if (open !== '{' && open !== '[') continue;
            const close = opens[open];
            let depth = 0, inStr = false, esc = false;
            for (let j = i; j < text.length; j++) {
                const c = text[j];
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') inStr = true;
                else if (c === open) depth++;
                else if (c === close) {
                    depth--;
                    if (depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
                }
            }
        }
        return out;
    }

    function normalizeToolCall(obj, validNames) {
        if (!obj || typeof obj !== 'object') return null;
        const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
        const name = fn.name || obj.name || obj.tool || obj.tool_name || obj.action;
        if (!name || !validNames.has(name)) return null;
        let args = fn.arguments !== undefined ? fn.arguments
            : (obj.arguments !== undefined ? obj.arguments
                : (obj.parameters !== undefined ? obj.parameters
                    : (obj.args !== undefined ? obj.args : {})));
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (e) { /* keep as-is below */ }
        }
        if (typeof args !== 'object' || args === null) args = {};
        return {
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name, arguments: args }
        };
    }

    function extractToolCallsFromText(content, extraNames) {
        if (!content || typeof content !== 'string') return null;
        const valid = new Set(toolNames());
        if (extraNames) for (const n of extraNames) valid.add(n);
        const calls = [];
        const seen = new Set();
        const push = (c) => {
            if (!c) return;
            const sig = c.function.name + JSON.stringify(c.function.arguments);
            if (seen.has(sig)) return;
            seen.add(sig);
            calls.push(c);
        };

        const candidates = [];
        // 1) <tool_call>...</tool_call> (Hermes/Qwen style)
        const tcTag = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let m;
        while ((m = tcTag.exec(content)) !== null) candidates.push(m[1]);
        // 2) Fenced ```json / ```tool_call blocks
        const fence = /```(?:json|tool_call|tool|tool_code)?\s*([\s\S]*?)```/g;
        while ((m = fence.exec(content)) !== null) candidates.push(m[1]);
        // 3) Whole content as a last resort (covers bare JSON replies)
        candidates.push(content);

        for (const cand of candidates) {
            for (const blob of scanJsonObjects(cand)) {
                let parsed;
                try { parsed = JSON.parse(blob); } catch (e) { continue; }
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const it of items) {
                    // Support {tool_calls:[...]} wrapper too
                    if (it && Array.isArray(it.tool_calls)) {
                        it.tool_calls.forEach(t => push(normalizeToolCall(t, valid)));
                    } else {
                        push(normalizeToolCall(it, valid));
                    }
                }
            }
            if (calls.length) break; // prefer the earliest structured block
        }
        return calls.length ? calls : null;
    }

    // Re-apply the harness-tracked per-step activityCount after replacing the plan
    // with a fresh copy loaded from disk. activityCount is loop state the mark_step_done
    // guard rail checks; a step whose only work was a non-persisting (read-only) tool
    // does not carry it on disk, so a plain Object.assign would wipe it and falsely trip
    // the guard. Use this anywhere the in-memory plan is replaced by a disk/verify copy.
    function assignPlanPreservingActivity(plan, incoming) {
        if (!incoming) return plan;
        const oldSteps = plan.steps || [];
        Object.assign(plan, incoming);
        if (Array.isArray(plan.steps)) {
            plan.steps.forEach(s => {
                const oldS = oldSteps.find(o => o.id === s.id);
                if (oldS && oldS.activityCount) s.activityCount = oldS.activityCount;
            });
        }
        return plan;
    }

    // Retain a deeper working window of recent turns than the old 6 so the model
    // keeps continuity across a multi-edit/debug sequence within one step. The
    // context budget in contextBuilder still trims these to fit num_ctx.
    function trimRecentTurns(turns, keep, threshold) {
        keep = keep || 14;
        threshold = threshold || 20;
        return turns.length > threshold ? turns.slice(-keep) : turns;
    }

    // --- Plugin system bridge -------------------------------------------------
    // Load enabled plugin tool schemas once per task into ctx. Plugins extend the
    // EXECUTION tool surface only (not planning, which is read-only discovery).
    async function loadPluginContext(ctx) {
        if (ctx._pluginsLoaded) return;
        ctx._pluginsLoaded = true;
        ctx.pluginTools = [];
        ctx.pluginToolNames = new Set();
        try {
            const res = await ctx.api.invoke('plugins-get-contributions');
            ctx.pluginTools = (res && res.tools) || [];
            for (const t of ctx.pluginTools) ctx.pluginToolNames.add(t.function.name);
        } catch (e) {
            // Plugin system is optional — never let it break the agent loop.
        }
    }

    // Fire a lifecycle hook; swallow all failures so a broken plugin can't wedge
    // the agent. before* hooks may return { blocked, reason, by } to veto.
    async function fireHookSafe(ctx, hookEvent, payload) {
        try {
            const r = await ctx.api.invoke('plugin-fire-hook', { hookEvent, payload });
            return r || { blocked: false };
        } catch (e) {
            return { blocked: false };
        }
    }

    // Never let a single tool exception kill the whole task — return the error to the
    // model as a tool result so it can recover, exactly like a normal tool failure.
    async function safeExecTool(name, args, ctx) {
        try {
            return await executeAgentTool(name, args, ctx);
        } catch (e) {
            return `Error executing ${name}: ${e && e.message ? e.message : String(e)}`;
        }
    }

    async function executeAgentTool(name, args, ctx) {
        const { api, plan, sudoInput, memoryToggle, saveToMemory, searchMemory } = ctx;
        
        const currentStep = plan ? plan.steps.find(s => s.id === plan.currentStepId) : null;
        if (currentStep && name !== 'mark_step_done' && name !== 'mark_step_blocked' && name !== 'run_verify' && name !== 'submit_plan') {
            currentStep.activityCount = (currentStep.activityCount || 0) + 1;
        }

        if (name === 'submit_plan') {
            // GUARD: a plan that is already approved+executing must NEVER be recreated.
            // plan-create makes a fresh awaiting_approval plan with currentStepId=null,
            // which strands the build (the "[BLOCKED step null]" loop). Small models
            // often re-emit submit_plan mid-build; refuse and steer them to act instead.
            if (plan && (plan.status === 'executing' || plan.status === 'done')) {
                return 'A plan is already approved and executing. Do NOT call submit_plan again. Work the CURRENT STEP now with read_file / edit_file / write_file / run_shell_command, then call mark_step_done. Use add_steps only if you need to ADD work.';
            }
            const res = await api.invoke('plan-create', {
                goal: args.goal,
                steps: args.steps,
                userText: ctx.userGoal,
                projectType: args.projectType || args.project_type
            });
            if (res.success) {
                // Carry over any files the model pinned with add_files during planning.
                if (ctx.pendingActiveFiles && ctx.pendingActiveFiles.length) {
                    res.plan.activeFiles = Array.from(new Set([...(res.plan.activeFiles || []), ...ctx.pendingActiveFiles]));
                    try { await api.invoke('plan-save', res.plan); } catch (e) { /* non-fatal */ }
                    ctx.pendingActiveFiles = [];
                }
                ctx.onPlanCreated(res.plan);
                return 'Plan submitted. Awaiting user approval.';
            }
            return `Error: ${res.error || 'plan create failed'}`;
        }

        if (name === 'mark_step_done') {
            const stepId = plan.currentStepId || "unknown";
            const step = plan.steps.find(s => s.id === stepId);
            
            if (step && (step.activityCount || 0) === 0) {
                return `[CRITICAL GUARD RAIL] Cannot mark step done: You have not executed any tools (like write_file, edit_file, read_file, run_command) during this step. You CANNOT assume a task is complete without physically doing the work or verifying it. Use the required tools first.`;
            }

            if (plan.verifyPolicy !== 'off' && step && !step.verifiedAt) {
                // Per-step gate: intermediate steps run only the cheap SYNTAX check (a
                // syntax error is never legitimate mid-build), so broken code is caught
                // immediately instead of piling up. The full lint/test suite still runs
                // only on the final step, where the deliverable should actually pass.
                const isFinalStep = !plan.steps.some(s => s.status === 'pending');
                const v = await api.invoke('agent-verify', plan.id, { syntaxOnly: !isFinalStep });
                if (!v.ok) {
                    const raw = (v.messages || []).join('\n');
                    return `Cannot mark step done: ${isFinalStep ? 'verification' : 'syntax check'} failed.\n${raw}${formatRepairBlock(raw)}\nFix the issue and try again.`;
                }
                assignPlanPreservingActivity(plan, v.plan);
                // v.ok was true but nothing real was checked — record it honestly so
                // the digest/review don't imply this step was verified.
                if (v.unverified) {
                    plan.scratchpad = ((plan.scratchpad || '') +
                        `\n[UNVERIFIED step ${stepId}]: completed without an automated check.`).slice(-4000);
                }
            }
            
            const stepToComplete = plan.steps.find(s => s.id === stepId);
            if (stepToComplete) {
                stepToComplete.status = 'done';
                stepToComplete.result = args.result || 'Completed';
            }
            const next = plan.steps.find(s => s.status === 'pending');
            if (next) {
                next.status = 'active';
                plan.currentStepId = next.id;
            } else {
                plan.currentStepId = null;
                plan.status = 'done';
            }
            await api.invoke('plan-save', plan);
            if (ctx.onStepAdvance) ctx.onStepAdvance(plan);
            return next
                ? `Step ${stepId} done. Now on step ${next.id}: ${next.title}`
                : `Step ${stepId} done. All steps complete.`;
        }

        if (name === 'mark_step_blocked') {
            const stepId = plan.currentStepId;
            const step = plan.steps.find(s => s.id === stepId);
            // Retry-then-skip: a model-initiated block first gets ONE chance to try a
            // different approach to the SAME step instead of stranding its dependents.
            // Harness-initiated auto-blocks (stall/loop/edit-fail) pass _auto and skip.
            const MAX_BLOCK_RETRY = 1;
            if (step && !args._auto && (step.blockAttempts || 0) < MAX_BLOCK_RETRY) {
                step.blockAttempts = (step.blockAttempts || 0) + 1;
                plan.scratchpad = ((plan.scratchpad || '') + `\n[RETRY step ${stepId}]: ${args.reason}`).slice(-4000);
                await api.invoke('plan-save', plan);
                return `Before giving up on step ${stepId}: ${args.reason}\nTry a DIFFERENT approach to the SAME step — re-read the relevant file, adjust your edit, or run a command to diagnose. (retry ${step.blockAttempts}/${MAX_BLOCK_RETRY}.) If it genuinely cannot be done, call mark_step_blocked again to skip it.`;
            }
            if (step) {
                step.status = 'failed';
                step.result = args.reason;
            }
            plan.scratchpad = (plan.scratchpad || '') + `\n[BLOCKED step ${stepId}]: ${args.reason}`;
            // Skip to the next pending step rather than failing the whole plan.
            // The execution loop enforces a consecutive-block ceiling to stop runaway failure.
            const next = plan.steps.find(s => s.status === 'pending');
            if (next) {
                next.status = 'active';
                plan.currentStepId = next.id;
            } else {
                plan.currentStepId = null;
                plan.status = plan.steps.some(s => s.status === 'failed') ? 'failed' : 'done';
            }
            await api.invoke('plan-save', plan);
            if (ctx.onPlanBlocked) ctx.onPlanBlocked(plan, args.reason);
            if (next && ctx.onStepAdvance) ctx.onStepAdvance(plan);
            return next
                ? `Step ${stepId} blocked (${args.reason}). Skipping to step ${next.id}: ${next.title}`
                : `Step ${stepId} blocked (${args.reason}). No more steps remain.`;
        }

        if (name === 'run_command' || name === 'run_shell_command') {
            let cmd = args.command;
            const sudoPass = sudoInput?.value || '';
            // The sudo rewrite is a bash idiom; on Windows/PowerShell it would corrupt
            // the command, so only apply it off-Windows.
            if (!IS_WINDOWS && cmd.includes('sudo') && sudoPass) {
                cmd = cmd.replace(/sudo\s+/g, `echo "${sudoPass}" | sudo -S `);
            }
            const res = await api.invoke('agent-run-command', cmd, args.is_background, plan.id);
            let out = '';
            if (res.error) out += `Error: ${res.error}\n`;
            if (res.stderr) out += `Stderr: ${res.stderr}\n`;
            if (res.stdout) out += `Stdout:\n${res.stdout}`;
            return out || 'Success';
        }

        if (name === 'read_file') {
            const filepath = args.filepath || args.file || args.path;
            const res = await api.invoke('agent-read-file', filepath, args.start, args.end);
            if (res.error) return `Error: ${res.error}`;
            // Auto-promote a file the model just read into the current step's context so
            // the dependency it's working against stays visible next turn instead of
            // falling out (capped to avoid bloating the prompt).
            const curStep = plan && plan.steps.find(s => s.id === plan.currentStepId);
            if (curStep && Array.isArray(curStep.filesTouched) && curStep.filesTouched.length < 12 && !curStep.filesTouched.includes(filepath)) {
                curStep.filesTouched.push(filepath);
            }
            return res.content;
        }

        if (name === 'write_file') {
            const filepath = args.filepath || args.file || args.path;
            const content = args.content ?? args.text ?? args.code;
            // Guard against a mis-keyed argument silently writing an EMPTY file over
            // real content (data loss). Require explicit content; empty files are rare
            // and can be made with run_shell_command.
            if (content === undefined || content === null || content === '') {
                return 'Error: write_file requires non-empty "content". Provide the complete file content. (To create an intentionally empty file, use run_shell_command.)';
            }
            const res = await api.invoke('agent-write-file', filepath, content, plan.id);
            if (res.error) return `Error: ${res.error}`;
            if (res.path) {
                const step = plan.steps.find(s => s.id === plan.currentStepId);
                if (step && !step.filesTouched.includes(res.path)) step.filesTouched.push(res.path);
                plan.filesLedger[res.path] = { created: res.created, lastAction: 'write' };
                if (!plan.projectRoot) {
                    const rootRes = await api.invoke('project-get-root');
                    plan.projectRoot = rootRes.projectRoot;
                }
                await api.invoke('plan-save', plan);
            }
            return res.success ? 'Success' : 'Error';
        }

        if (name === 'edit_file') {
            const filepath = args.filepath || args.file || args.path;
            const find = args.find ?? args.search ?? args.old_string;
            const replace = args.replace ?? args.new_string ?? args.text ?? args.code;
            const res = await api.invoke('edit-apply', {
                planId: plan.id,
                filepath: filepath,
                find: find,
                replace: replace
            });
            if (res.error) {
                if (res.closest) return `Error: ${res.error}\nClosest regions:\n${res.closest.join('\n')}`;
                return `Error: ${res.error}`;
            }
            if (res.relPath) {
                const step = plan.steps.find(s => s.id === plan.currentStepId);
                if (step && !step.filesTouched.includes(res.relPath)) step.filesTouched.push(res.relPath);
                await api.invoke('plan-save', plan);
            }
            return res.note ? `Success (${res.note})` : 'Success';
        }

        if (name === 'list_directory') {
            const res = await api.invoke('agent-list-directory', args.dirpath || args.path || '.');
            return res.files || res.error || 'Empty';
        }

        if (name === 'list_project') {
            const res = await api.invoke('agent-list-project');
            return res.listing || res.error || 'Empty';
        }

        if (name === 'delete_file') {
            const res = await api.invoke('agent-delete-file', args.filepath, plan.id);
            return res.success ? 'Success' : `Error: ${res.error}`;
        }

        if (name === 'set_project_root') {
            const res = await api.invoke('project-set-root', args.path);
            if (res.success) {
                plan.projectRoot = res.projectRoot;
                await api.invoke('plan-save', plan);
                return `Project root set to ${res.projectRoot}`;
            }
            return `Error: ${res.error}`;
        }

        if (name === 'search_memory' || name === 'memory_search') {
            const mems = await searchMemory(args.query);
            return mems.length ? mems.map(m => m.text).join('\n') : 'No memory found';
        }

        if (name === 'save_fact' || name === 'save_new_user_fact_only') {
            if (!memoryToggle?.checked) return 'Memory disabled';
            const res = await saveToMemory(args.fact || args.exact_new_fact);
            return res?.success ? 'Fact saved.' : `Error: ${res?.error || 'failed'}`;
        }

        if (name === 'read_process_log') {
            const res = await api.invoke('agent-read-process-log', args.job_id, args.lines);
            return res.error ? `Error: ${res.error}` : res.log;
        }

        if (name === 'web_search') {
            const results = await api.invoke('perform-search', args.query);
            if (results && !results.error && results.length > 0) {
                return results.map(r => `${r.title}: ${r.snippet} (${r.url})`).join('\n');
            }
            return 'No results found.';
        }

        if (name === 'grep_project') {
            const res = await api.invoke('agent-grep', {
                pattern: args.pattern,
                path: args.path,
                glob: args.glob,
                case_insensitive: args.case_insensitive
            });
            if (res.error) return `Error: ${res.error}`;
            if (!res.hits?.length) return 'No matches.';
            return res.hits.map(h => `${h.file}:${h.line}: ${h.text.trim()}`).join('\n') +
                (res.truncated ? '\n(truncated)' : '');
        }

        if (name === 'glob_files') {
            const res = await api.invoke('agent-glob', { pattern: args.pattern, path: args.path });
            if (res.error) return `Error: ${res.error}`;
            return (res.files || []).join('\n') || 'No files.';
        }

        if (name === 'get_repo_map') {
            const res = await api.invoke('agent-get-repo-map', { maxTokens: 1500 });
            return res.map || res.error || 'Empty map';
        }

        if (name === 'apply_patch') {
            const filepath = args.filepath || args.file || args.path;
            const patch = args.patch || args.diff || args.content || args.text;
            const res = await api.invoke('edit-apply-patch', {
                planId: plan.id,
                filepath: filepath,
                patch: patch
            });
            if (res.error) return `Error: ${res.error}`;
            if (res.relPath) {
                const step = plan.steps.find(s => s.id === plan.currentStepId);
                if (step && !step.filesTouched.includes(res.relPath)) step.filesTouched.push(res.relPath);
                await api.invoke('plan-save', plan);
            }
            return 'Patch applied.';
        }

        if (name === 'apply_edits') {
            const edits = args.edits || args.changes || args.files || [];
            const res = await api.invoke('edit-apply-batch', { planId: plan.id, edits: edits });
            // Record every successfully-edited file on the plan so it stays tracked in
            // the change ledger and is re-surfaced in context next turn — parity with
            // edit_file/apply_patch, which the batch path previously skipped.
            if (!plan.filesLedger) plan.filesLedger = {};
            const step = plan.steps.find(s => s.id === plan.currentStepId);
            let touched = 0;
            for (const r of (res.results || [])) {
                const rel = r.result?.relPath;
                if (r.result?.success && rel) {
                    if (step && !step.filesTouched.includes(rel)) step.filesTouched.push(rel);
                    plan.filesLedger[rel] = { created: !!r.result.created, lastAction: 'edit' };
                    touched++;
                }
            }
            if (touched) await api.invoke('plan-save', plan);
            if (!res.success) {
                const errs = (res.results || []).filter(r => r.result?.error).map(r => r.result.error);
                return `Applied ${touched} edit(s); some failed: ${errs.join('; ')}`;
            }
            return `Applied ${touched || (res.results || []).length} edits.`;
        }

        if (name === 'add_files') {
            const paths = Array.isArray(args.paths) ? args.paths : (args.paths ? [args.paths] : (args.files || []));
            // During PLANNING there is no plan yet — pinning a file used to crash here
            // (`Cannot read properties of null (reading 'activeFiles')`), which killed
            // the whole task before any writing. Stash the pins and apply them when the
            // plan is created instead of throwing.
            if (!plan) {
                ctx.pendingActiveFiles = ctx.pendingActiveFiles || [];
                for (const p of paths) if (p && !ctx.pendingActiveFiles.includes(p)) ctx.pendingActiveFiles.push(p);
                return `Noted ${paths.length} file(s) to keep in scope once the build starts. Call submit_plan to begin, or read_file to inspect now.`;
            }
            plan.activeFiles = plan.activeFiles || [];
            for (const p of paths) {
                if (p && !plan.activeFiles.includes(p)) plan.activeFiles.push(p);
            }
            await api.invoke('plan-save', plan);
            return `Active files: ${plan.activeFiles.join(', ')}`;
        }

        if (name === 'drop_files') {
            const paths = Array.isArray(args.paths) ? args.paths : (args.paths ? [args.paths] : (args.files || []));
            const drop = new Set(paths);
            if (!plan) {
                ctx.pendingActiveFiles = (ctx.pendingActiveFiles || []).filter(p => !drop.has(p));
                return `Active files: ${(ctx.pendingActiveFiles || []).join(', ') || '(none)'}`;
            }
            plan.activeFiles = (plan.activeFiles || []).filter(p => !drop.has(p));
            await api.invoke('plan-save', plan);
            return `Active files: ${(plan.activeFiles || []).join(', ') || '(none)'}`;
        }

        if (name === 'send_input') {
            const res = await api.invoke('agent-send-input', args.job_id, args.input);
            return res.success ? 'Input sent successfully.' : `Error: ${res.error}`;
        }

        if (name === 'provide_file_download_link') {
            const filepath = args.filepath || args.file || args.path;
            const encodedPath = encodeURIComponent(filepath);
            const fileName = filepath.split(/[\/\\]/).pop();
            return `I have generated the download link. Provide this exact markdown to the user: [Download ${fileName}](/download_remote?file=${encodedPath})`;
        }

        if (name === 'send_whatsapp_message') {
            const res = await api.invoke('whatsapp-send', { number: args.number, message: args.message });
            return res.success ? 'Success' : 'Error';
        }

        if (name === 'dynamic_schema_generate') {
            return JSON.stringify({
                task: args.task,
                schema: {
                    type: "object",
                    properties: (args.fields || []).reduce((a, f) => ({ ...a, [f]: { type: "string" } }), {})
                }
            });
        }

        if (name === 'run_verify') {
            const v = await api.invoke('agent-verify', plan.id);
            if (v.unverified) {
                assignPlanPreservingActivity(plan, v.plan);
                return '[UNVERIFIED] No automated verification is available for the files you changed (no test/lint command was detected, and there is no syntax checker installed for their language). The code was NOT checked. Read it carefully and run it yourself with run_shell_command before mark_step_done — do not claim it is verified.';
            }
            if (v.ok) {
                assignPlanPreservingActivity(plan, v.plan);
                return 'Verification passed (lint/test). You MUST call mark_step_done immediately to complete this step. Do NOT just say you verified it.';
            }
            return `Verification failed:\n${(v.messages || []).join('\n')}`;
        }

        if (name === 'record_decision') {
            if (!plan.decisions) plan.decisions = [];
            if (args.text && !plan.decisions.includes(args.text)) plan.decisions.push(args.text);
            await api.invoke('plan-save', plan);
            return 'Decision recorded.';
        }

        if (name === 'init_project') {
            await api.invoke('git-init', plan.id);
            if (args.command) {
                const res = await api.invoke('agent-run-command', args.command, false, plan.id);
                return res.stdout || res.stderr || res.error || 'Init complete';
            }
            return 'Git initialized.';
        }

        if (name === 'add_steps') {
            const titles = Array.isArray(args.steps) ? args.steps : (args.steps ? [args.steps] : []);
            if (!titles.length) return 'Error: add_steps requires a non-empty "steps" array.';
            const res = await api.invoke('plan-add-steps', { planId: plan.id, steps: titles });
            if (res.error) return `Error: ${res.error}`;
            assignPlanPreservingActivity(plan, res.plan);
            if (ctx.onStepAdvance) ctx.onStepAdvance(plan);
            return `Added ${res.added.length} step(s): ${res.added.map(s => `${s.id}. ${s.title}`).join('; ')}`;
        }

        if (name === 'fetch_url') {
            const url = args.url || args.link || args.href;
            if (!url) return 'Error: fetch_url requires a "url".';
            const res = await api.invoke('agent-fetch-url', url);
            if (res.error) return `Error fetching ${url}: ${res.error}`;
            return res.content || '(empty response)';
        }

        if (name === 'list_processes') {
            const res = await api.invoke('agent-list-processes');
            const jobs = res.jobs || [];
            if (!jobs.length) return 'No background processes.';
            return jobs.map(j => `Job ${j.jobId}: ${j.running ? 'RUNNING' : `exited(${j.exitCode})`} — ${j.command} | last: ${j.lastLine}`).join('\n');
        }

        if (name === 'stop_process') {
            const jobId = args.job_id ?? args.jobId ?? args.id;
            if (jobId == null) return 'Error: stop_process requires a "job_id".';
            const res = await api.invoke('agent-stop-process', jobId);
            return res.error ? `Error: ${res.error}` : (res.stdout || 'Stopped.');
        }

        // Plugin-provided tool? Route to the main-process plugin manager.
        if (ctx.pluginToolNames && ctx.pluginToolNames.has(name)) {
            const res = await api.invoke('plugin-invoke-tool', { tool: name, args });
            return res && typeof res.result === 'string' ? res.result : String(res && res.result);
        }

        const pluginNames = ctx.pluginToolNames ? Array.from(ctx.pluginToolNames) : [];
        return `Unknown tool: ${name}. Available: ${toolNames().concat(pluginNames).join(', ')}`;
    }

    function isMutatingTool(name) {
        return !READ_ONLY_TOOLS.has(name) && name !== 'mark_step_done' && name !== 'mark_step_blocked' &&
            name !== 'record_decision' && name !== 'submit_plan';
    }

    async function runPostMutateVerify(ctx, plan) {
        if (plan.verifyPolicy === 'off') return null;
        const v = await ctx.api.invoke('agent-verify', plan.id);
        assignPlanPreservingActivity(plan, v.plan);
        if (!v.ok) {
            const raw = (v.messages || []).join('\n');
            return `[VERIFY FAILED]\n${raw}${formatRepairBlock(raw)}\nFix and retry.`;
        }
        return null;
    }

    async function streamCompletion(options) {
        const { endpoint, body, abortSignal, onDelta, uplinkMode, extraToolNames } = options;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer lm-studio' },
            body: JSON.stringify(body),
            signal: abortSignal
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`API error (${res.status}): ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let toolCalls = null;
        let finishReason = null;
        let leftover = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = (leftover + chunk).split('\n');
            leftover = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (uplinkMode && trimmed.startsWith('data:')) {
                    try {
                        const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
                        const json = JSON.parse(jsonStr);
                        const delta = json.choices?.[0]?.delta;
                        if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                        if (delta?.content) {
                            fullContent += delta.content;
                            if (onDelta) onDelta(fullContent);
                        }
                        if (delta?.tool_calls) {
                            if (!toolCalls) toolCalls = [];
                            delta.tool_calls.forEach(tc => {
                                const idx = tc.index ?? toolCalls.length;
                                if (!toolCalls[idx]) {
                                    toolCalls[idx] = tc;
                                    if (!toolCalls[idx].id) toolCalls[idx].id = `call_${Math.random().toString(36).slice(2, 10)}`;
                                    if (toolCalls[idx].function && !toolCalls[idx].function.arguments) {
                                        toolCalls[idx].function.arguments = '';
                                    }
                                } else {
                                    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                                    if (tc.id) toolCalls[idx].id = tc.id;
                                    if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                                }
                            });
                        }
                    } catch (e) { /* skip bad chunk */ }
                }
            }
        }

        if (toolCalls) {
            toolCalls = toolCalls.filter(Boolean).map(tc => {
                if (typeof tc.function.arguments === 'string') {
                    try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { tc.function.arguments = {}; }
                }
                return tc;
            });
        }

        // Fallback: models without reliable native tool-calling (Gemma 3n E4B, etc.)
        // emit the call as text. Recover it so the agent loop can still progress.
        let toolCallsFromText = false;
        if ((!toolCalls || !toolCalls.length) && fullContent) {
            const recovered = extractToolCallsFromText(fullContent, extraToolNames);
            if (recovered) {
                toolCalls = recovered;
                toolCallsFromText = true;
            }
        }

        return { fullContent, toolCalls, finishReason, toolCallsFromText };
    }

    async function runPlanningPhase(ctx) {
        const mems = ctx.memoryToggle?.checked ? await ctx.searchMemory(ctx.userGoal) : [];
        const messages = await global.XKContextBuilder.buildPlanningContext({
            api: ctx.api,
            userGoal: ctx.userGoal,
            numCtx: ctx.numCtx,
            memorySnippets: mems,
            envContext: ctx.envContext,
            chatHistory: ctx.chatHistory || [],
            plan: ctx.plan
        });

        const planningTools = PLAN_TOOLS.filter(t => PLANNING_TOOLS.has(t.function.name));
        const MAX_PLANNING_TURNS = ctx.maxPlanningTurns || 6;
        let nudged = false;
        let lastContent = '';

        // Loop so the planner can explore (grep/read/repo map) over several turns
        // before calling submit_plan, instead of aborting after a single response.
        for (let turn = 0; turn < MAX_PLANNING_TURNS; turn++) {
            // Inject live User Hints directly into the planning timeline
            if (ctx.unprocessedHints && ctx.unprocessedHints.length > 0) {
                const hintText = ctx.unprocessedHints.join('\n');
                ctx.unprocessedHints = [];
                messages.push({ role: 'user', content: `[USER INTERVENTION / HINT]: ${hintText}\nConsider this hint while building your plan.` });
                turn = Math.max(0, turn - 2); // give planner more turns
            }

            const body = {
                model: ctx.plannerModel || ctx.model,
                messages,
                stream: true,
                temperature: ctx.temperature,
                max_tokens: -1,
                tools: planningTools
            };

            const result = await streamCompletion({
                endpoint: `${apiBase(ctx.currentApiBase)}/v1/chat/completions`,
                body,
                abortSignal: ctx.abortSignal,
                uplinkMode: true,
                onDelta: ctx.onDelta
            });
            lastContent = result.fullContent || lastContent;

            if (result.toolCalls?.length) {
                // Record the assistant turn so tool results have a valid parent.
                const calls = result.toolCalls.slice(0, 8);
                messages.push({
                    role: 'assistant',
                    content: result.fullContent || '',
                    tool_calls: calls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) }
                    }))
                });

                for (const tc of calls) {
                    const tn = tc.function.name;
                    if (tn === 'submit_plan') {
                        await executeAgentTool('submit_plan', tc.function.arguments, ctx);
                        if (ctx.plan) return { phase: 'awaiting_approval', plan: ctx.plan };
                    }
                    if (ctx.onToolCall) ctx.onToolCall(tn, tc.function.arguments || {}, tc.id);
                    if (PLANNING_TOOLS.has(tn)) {
                        const out = await safeExecTool(tn, tc.function.arguments, ctx);
                        if (ctx.onToolResult) ctx.onToolResult(tn, out, tc.id);
                        messages.push({ role: 'tool', name: tn, content: String(out), tool_call_id: tc.id });
                    } else {
                        // A write/edit tool during planning is not allowed; steer back.
                        const notAllowed = `Tool "${tn}" is not available in the read-only planning phase. Explore with read tools, then call submit_plan.`;
                        if (ctx.onToolResult) ctx.onToolResult(tn, notAllowed, tc.id);
                        messages.push({ role: 'tool', name: tn, content: notAllowed, tool_call_id: tc.id });
                    }
                }
                nudged = false;
                continue;
            }

            // No tool call this turn: nudge once, then give up.
            if (!nudged) {
                nudged = true;
                if (result.fullContent) messages.push({ role: 'assistant', content: result.fullContent });
                messages.push({ role: 'user', content: 'Now call submit_plan with the goal, projectType, and ordered step titles. Use a tool call.' });
                continue;
            }
            break;
        }

        if (lastContent) ctx.onMessage(lastContent);
        return { phase: 'planning_failed', content: lastContent };
    }

    async function waitForApproval(plan, ui) {
        return new Promise((resolve, reject) => {
            ui.showPlanPanel(plan, {
                onApprove: async (editedPlan) => {
                    editedPlan.status = 'executing';
                    const first = editedPlan.steps.find(s => s.status === 'pending' || s.status === 'active');
                    if (first) {
                        first.status = 'active';
                        editedPlan.currentStepId = first.id;
                    }
                    await window.api.invoke('plan-save', editedPlan);
                    const res = await window.api.invoke('plan-approve', editedPlan.id);
                    resolve(res.plan || editedPlan);
                },
                onAbort: () => reject(new Error('User aborted plan'))
            });
        });
    }

    async function runExecutionPhase(ctx) {
        const plan = ctx.plan;
        // Make enabled plugin tools available this run (fresh task AND resume).
        await loadPluginContext(ctx);
        // Build mode budgets *turns*, not steps: each plan step legitimately needs
        // several model turns (read, edit, verify, retry). Scale the budget to the plan
        // size with a generous per-step allowance so multi-step builds can actually
        // finish. The chat "Thinking Steps" slider (ctx.maxSteps) only acts as a floor.
        const TURNS_PER_STEP = ctx.turnsPerStep || 30;
        const maxSteps = Math.max(ctx.maxSteps || 0, (plan.steps?.length || 1) * TURNS_PER_STEP);
        let turnCount = 0;
        let recentTurns = [];
        let stallCount = 0;
        let lastProgressSig = '';
        let editFailures = 0;
        let blockedCount = 0;
        let reflectionCount = 0;
        let lastToolReceipt = '';
        let lengthCutoffCount = 0;
        ctx._lastToolSig = null;
        const EDIT_RETRY_MAX = 3;
        const STALL_MAX = 8;
        const MAX_CONSECUTIVE_BLOCKS = 3;
        const MAX_REFLECTIONS = 3;

        while (plan.status === 'executing' && turnCount < maxSteps) {
            turnCount++;
            const currentStep = plan.steps.find(s => s.id === plan.currentStepId);
            if (!currentStep) break;

            ctx.onStepUpdate(plan, currentStep);

            // Inject any newly received live User Hints directly into the execution timeline
            if (ctx.unprocessedHints && ctx.unprocessedHints.length > 0) {
                const hintText = ctx.unprocessedHints.join('\n');
                ctx.unprocessedHints = []; // clear them
                recentTurns.push({ role: 'user', content: `[USER INTERVENTION / HINT]: ${hintText}\nAdjust your current approach based on this hint, then call a tool.` });
                stallCount = 0; // reset stall counter when user intervenes
                turnCount = Math.max(0, turnCount - 10); // give more breathing room on hints
            }

            const mems = ctx.memoryToggle?.checked
                ? await ctx.searchMemory(currentStep.title + ' ' + plan.goal)
                : [];

            const messages = await global.XKContextBuilder.buildExecutionContext({
                api: ctx.api,
                plan,
                currentStep,
                numCtx: ctx.numCtx,
                recentTurns,
                memorySnippets: mems,
                envContext: ctx.envContext,
                lastToolReceipt,
                chatHistory: ctx.chatHistory || [],
                shell: HOST_SHELL,
                model: ctx.editorModel || ctx.model
            });

            const body = {
                model: ctx.editorModel || ctx.model,
                messages,
                stream: true,
                temperature: ctx.temperature,
                max_tokens: -1,
                tools: [...EXECUTION_TOOLS, ...(ctx.pluginTools || [])]
            };

            const result = await streamCompletion({
                endpoint: `${apiBase(ctx.currentApiBase)}/v1/chat/completions`,
                body,
                abortSignal: ctx.abortSignal,
                uplinkMode: true,
                extraToolNames: ctx.pluginToolNames ? Array.from(ctx.pluginToolNames) : [],
                onDelta: (text) => ctx.onDelta(text, turnCount)
            });

            if (result.finishReason === 'length') {
                lengthCutoffCount++;
                if (lengthCutoffCount > 3) {
                    await executeAgentTool('mark_step_blocked', { reason: 'Generation cut off too many times due to context limits', _auto: true }, ctx);
                    break;
                }
                recentTurns.push({ role: 'user', content: '[SYSTEM]: Generation was cut off. Use smaller edits or read_file with line ranges.' });
                continue;
            } else {
                lengthCutoffCount = 0;
            }

            if (!result.toolCalls?.length) {
                if (result.fullContent) {
                    recentTurns.push({ role: 'assistant', content: result.fullContent });
                }
                stallCount++;
                if (stallCount >= STALL_MAX) {
                    await executeAgentTool('mark_step_blocked', { reason: 'No tool calls — stalled', _auto: true }, ctx);
                    break;
                }

                const isFinishedHint = result.fullContent && result.fullContent.length < 50 && result.fullContent.toLowerCase().includes('done');
                const stallMsg = stallCount > 2
                    ? '[SYSTEM URGENT]: You are stalling. If you have verified the completion of this step, you MUST use the "mark_step_done" tool NOW. Do NOT reply with plain text confirming you are done. Use the tool.'
                    : isFinishedHint
                        ? '[SYSTEM NUDGE]: If you are finished with this step, you MUST use the mark_step_done tool.'
                        : '[SYSTEM NUDGE]: You did not call any tools. You MUST call a tool (e.g., edit_file, write_file, read_file, run_shell_command) to take action and progress the step, or mark_step_done if the step is verified and complete. Do not just output text.';

                recentTurns.push({ role: 'user', content: stallMsg });
                continue;
            }
            const MAX_TOOL_CALLS_PER_TURN = 8;
            const toolCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
            const droppedCalls = result.toolCalls.length - toolCalls.length;

            const assistantMsg = {
                role: 'assistant',
                content: result.fullContent || '',
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) }
                }))
            };
            recentTurns.push(assistantMsg);

            // Duplicate tool call detection to break infinite loops
            const currentSig = toolCalls.map(tc => `${tc.function.name}:${JSON.stringify(tc.function.arguments || {})}`).join('|');
            const allReadOnly = toolCalls.length > 0 && toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.function.name));
            const dupThreshold = allReadOnly ? 5 : 2;
            if (ctx._lastToolSig === currentSig) {
                ctx._dupCount = (ctx._dupCount || 0) + 1;
                // Allow deliberate repeats (e.g. re-running tests). Read-only inspection
                // steps need more tolerance — small models often re-list before mark_step_done.
                if (ctx._dupCount >= dupThreshold) {
                    stallCount++;
                    if (stallCount >= STALL_MAX) {
                        await executeAgentTool('mark_step_blocked', { reason: 'Infinite tool loop detected', _auto: true }, ctx);
                        break;
                    }
                    const loopNudge = allReadOnly
                        ? '[SYSTEM NUDGE]: You have repeated the same read-only tool call several times. Summarize what you learned and call mark_step_done, or switch to write_file/edit_file if the step requires implementation.'
                        : '[SYSTEM NUDGE]: You have issued the EXACT same tool call(s) several turns in a row, which causes an infinite loop. Read the results above carefully. You MUST try a different approach, edit a different file/line, or use mark_step_done / mark_step_blocked.';
                    recentTurns.push({ role: 'user', content: loopNudge });
                    continue;
                }
            } else {
                ctx._dupCount = 0;
            }
            ctx._lastToolSig = currentSig;

            const toRun = toolCalls;
            const toolResults = [];
            let hadMutate = false;

            for (const tc of toRun) {
                const toolName = tc.function.name;
                const toolArgs = tc.function.arguments || {};
                ctx.onToolCall(toolName, toolArgs, tc.id);
                let toolResult;
                const pre = await fireHookSafe(ctx, 'beforeToolCall', { toolName, args: toolArgs });
                if (pre && pre.blocked) {
                    toolResult = `[BLOCKED by plugin ${pre.by || ''}]: ${pre.reason || 'tool call vetoed by a plugin hook'}`;
                } else {
                    toolResult = await safeExecTool(toolName, toolArgs, ctx);
                    await fireHookSafe(ctx, 'afterToolCall', { toolName, args: toolArgs, result: String(toolResult) });
                }
                if (ctx.onToolResult) ctx.onToolResult(toolName, toolResult, tc.id);
                toolResults.push({ toolName, toolResult, id: tc.id });
                recentTurns.push({ role: 'tool', name: toolName, content: String(toolResult), tool_call_id: tc.id });
                if (isMutatingTool(toolName)) hadMutate = true;
                if (toolName === 'mark_step_done' || toolName === 'mark_step_blocked') break;
            }

            lastToolReceipt = toolResults.map(r => `[${r.toolName}]\n${r.toolResult}`).join('\n\n');

            // If the model emitted more calls than we ran this turn, tell it explicitly
            // instead of silently dropping them (which causes state drift — the model
            // believes a file it "wrote" exists when that call never executed).
            if (droppedCalls > 0) {
                recentTurns.push({ role: 'user', content: `[SYSTEM]: You issued ${result.toolCalls.length} tool calls but only the first ${toolCalls.length} were executed this turn. Re-issue the remaining ${droppedCalls} call(s) now — do not assume they ran.` });
            }

            // Auto-verify after a mutation only matters near the deliverable. Running the
            // full lint/test suite after EVERY edit on a multi-step build is slow and
            // tests half-finished code; mid-build the model calls run_verify explicitly.
            const isFinalStepNow = !plan.steps.some(s => s.status === 'pending');
            const shouldAutoVerify = plan.verifyPolicy === 'strict' || isFinalStepNow;
            if (hadMutate && shouldAutoVerify && !toolResults.some(r => r.toolName === 'mark_step_done')) {
                const reflect = await runPostMutateVerify(ctx, plan);
                if (reflect) {
                    reflectionCount++;
                    recentTurns.push({ role: 'user', content: reflect });
                    // Only HARD-BLOCK on persistent verification failure for the final
                    // step (or strict policy). Mid-build, a red test suite is expected;
                    // keep nudging but don't kill the plan — stop spamming after the cap.
                    const isFinalStep = !plan.steps.some(s => s.status === 'pending');
                    if (reflectionCount >= MAX_REFLECTIONS && (plan.verifyPolicy === 'strict' || isFinalStep)) {
                        await executeAgentTool('mark_step_blocked', { reason: 'Too many verification failures', _auto: true }, ctx);
                        break;
                    }
                    if (reflectionCount > MAX_REFLECTIONS) {
                        // Stop re-running verify every turn for intermediate steps.
                        recentTurns.pop();
                    }
                } else {
                    reflectionCount = 0;
                }
            }

            await window.api.invoke('plan-save', plan);
            const reloaded = await window.api.invoke('plan-load', plan.id);
            if (!reloaded.error) {
                const oldSteps = plan.steps || [];
                const oldStepId = plan.currentStepId;
                Object.assign(plan, reloaded);
                if (plan.steps) {
                    plan.steps.forEach(s => {
                        const oldS = oldSteps.find(o => o.id === s.id);
                        if (oldS && oldS.activityCount) {
                            s.activityCount = oldS.activityCount;
                        }
                    });
                }
                if (!plan.currentStepId && oldStepId) {
                    plan.currentStepId = oldStepId;
                }
                if (ctx.onStepAdvance) ctx.onStepAdvance(plan);
            }

            const lastName = toolResults[toolResults.length - 1]?.toolName;
            // Read-only investigation (read/grep/glob/list/repo-map/fetch) legitimately
            // changes no files — don't count it toward the "no progress" ceiling, or a
            // model carefully reading several files before editing gets its step killed.
            const usedReadOnly = toolResults.some(r => READ_ONLY_TOOLS.has(r.toolName));
            const progressSig = `${plan.currentStepId}:${JSON.stringify(plan.filesLedger)}`;
            if (progressSig !== lastProgressSig || lastName === 'mark_step_done') {
                stallCount = 0;
                editFailures = 0;
                lastProgressSig = progressSig;
            } else if (!usedReadOnly) {
                stallCount++;
                if (stallCount >= STALL_MAX * 2) {
                    await executeAgentTool('mark_step_blocked', { reason: `No progress made for ${STALL_MAX * 2} consecutive turns.`, _auto: true }, ctx);
                    break;
                }
            }

            if (toolResults.some(r => r.toolName === 'edit_file' && String(r.toolResult).startsWith('Error:'))) {
                editFailures++;
                if (editFailures >= EDIT_RETRY_MAX) {
                    await executeAgentTool('mark_step_blocked', { reason: `Edit failed ${EDIT_RETRY_MAX} times`, _auto: true }, ctx);
                    break;
                }
            }

            if (lastName === 'mark_step_blocked') {
                blockedCount++;
                if (blockedCount >= MAX_CONSECUTIVE_BLOCKS) {
                    plan.status = 'failed';
                    await window.api.invoke('plan-save', plan);
                    break;
                }
            } else if (lastName === 'mark_step_done') {
                blockedCount = 0;
                // Checkpoint after EVERY completed step (not just the final one) so
                // progress is recoverable mid-build. No-ops harmlessly if the project
                // isn't a git repo.
                if (ctx.autoGitCommit !== false) {
                    const tag = plan.status === 'done' ? 'complete' : `step ${currentStep?.id} done`;
                    await ctx.api.invoke('git-commit', {
                        message: `Xkaliber: ${plan.goal} — ${tag}`,
                        planId: plan.id
                    });
                }
            }

            if (plan.status === 'done' || plan.status === 'failed') break;

            recentTurns = trimRecentTurns(recentTurns, ctx.maxRecentTurns);
        }

        // The plan is still executing but we ran out of turn budget. Surface this
        // instead of silently freezing the UI on the last step; the plan stays
        // 'executing' so it remains resumable from the resume banner.
        if (plan.status === 'executing' && turnCount >= maxSteps) {
            const note = `Reached the turn budget (${maxSteps} turns) before finishing the plan. ` +
                `Paused at step ${plan.currentStepId}. Send a hint or use Resume to continue.`;
            plan.scratchpad = ((plan.scratchpad || '') + `\n[HALTED] ${note}`).slice(-4000);
            try { await window.api.invoke('plan-save', plan); } catch (e) { /* non-fatal */ }
            if (ctx.onMessage) ctx.onMessage(note);
        }

        if (plan.status === 'done' || plan.status === 'failed') {
            await fireHookSafe(ctx, 'onPlanDone', { planId: plan.id, status: plan.status, goal: plan.goal });
        }

        return plan;
    }

    async function runReviewPhase(plan, ctx) {
        const diffRes = await ctx.api.invoke('ledger-diff', plan.id);
        const gitLog = await ctx.api.invoke('git-log', 8).catch(() => ({ lines: [] }));
        ctx.onReview(plan, diffRes.diff || '', gitLog.lines || []);
        return plan;
    }

    async function runAgentTask(ctx) {
        ctx.plan = null;
        ctx.onPlanCreated = (plan) => { ctx.plan = plan; };

        const planningResult = await runPlanningPhase(ctx);
        if (planningResult.phase !== 'awaiting_approval' || !ctx.plan) {
            return planningResult;
        }

        const approvedPlan = await waitForApproval(ctx.plan, ctx.ui);
        ctx.plan = approvedPlan;

        await loadPluginContext(ctx);
        await fireHookSafe(ctx, 'onPlanApproved', { planId: ctx.plan.id, goal: ctx.plan.goal, steps: (ctx.plan.steps || []).map(s => s.title) });

        await runExecutionPhase(ctx);

        if (ctx.plan.status === 'done') {
            if (ctx.memoryToggle?.checked) {
                const summary = `Project: ${ctx.plan.goal}. Decisions: ${ctx.plan.decisions.join('; ')}. Files: ${Object.keys(ctx.plan.filesLedger).join(', ')}`;
                await ctx.saveToMemory(summary, { type: 'project_memory', planId: ctx.plan.id });
            }
            await runReviewPhase(ctx.plan, ctx);
        }

        return { phase: 'complete', plan: ctx.plan };
    }

    global.XKAgentLoop = {
        PLAN_TOOLS,
        EXECUTION_TOOLS,
        READ_ONLY_TOOLS,
        PLANNING_TOOLS,
        toolNames,
        executeAgentTool,
        runAgentTask,
        runExecutionPhase,
        runReviewPhase,
        waitForApproval,
        isMutatingTool,
        runPostMutateVerify,
        extractToolCallsFromText,
        trimRecentTurns,
        loadPluginContext,
        fireHookSafe
    };
    // CommonJS export for unit tests / headless use.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.XKAgentLoop;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
