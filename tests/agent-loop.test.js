const { test } = require('node:test');
const assert = require('node:assert');

// contextBuilder must load before agentLoop (agentLoop reads global.XKContextBuilder)
const ctxBuilder = require('../contextBuilder.js');
const { buildExecutionContext } = ctxBuilder;
const agentLoop = require('../agentLoop.js');
const { executeAgentTool, runExecutionPhase, trimRecentTurns } = agentLoop;

// --- shared in-memory IPC mock, mirroring the real main.js handlers ---------
function makeApi(disk) {
    return {
        async invoke(channel, ...args) {
            if (channel === 'plan-save') { disk.plan = JSON.parse(JSON.stringify(args[0])); return { success: true }; }
            if (channel === 'plan-load') { return JSON.parse(JSON.stringify(disk.plan)); }
            if (channel === 'agent-verify') {
                // real handler loads from DISK, marks verified, saves, returns that disk copy
                const plan = JSON.parse(JSON.stringify(disk.plan));
                if (plan.currentStepId) { const s = plan.steps.find(x => x.id === plan.currentStepId); if (s) s.verifiedAt = Date.now(); }
                disk.plan = JSON.parse(JSON.stringify(plan));
                return { ok: true, messages: [], plan };
            }
            if (channel === 'agent-write-file') return { success: true, path: args[0], created: true };
            if (channel === 'agent-read-file') return { content: 'source' };
            if (channel === 'agent-get-repo-map') return { map: '' };
            if (channel === 'project-get-root') return { projectRoot: '/proj' };
            return { success: true };
        }
    };
}

// ===========================================================================
// B1: read-only work + run_verify must not erase the proof-of-work that the
// guard rail checks, so mark_step_done can still complete the step.
// ===========================================================================
test('B1: read_file + run_verify then mark_step_done advances the step', async () => {
    const disk = { plan: null };
    const plan = {
        id: 'p1', goal: 'review', status: 'executing', verifyPolicy: 'block',
        steps: [
            { id: 1, title: 'review code (read-only)', status: 'active', result: '', filesTouched: [], verifiedAt: null },
            { id: 2, title: 'next', status: 'pending', result: '', filesTouched: [], verifiedAt: null },
        ],
        currentStepId: 1, filesLedger: {}, decisions: [], scratchpad: '', activeFiles: [],
    };
    disk.plan = JSON.parse(JSON.stringify(plan));
    const ctx = { api: makeApi(disk), plan, memoryToggle: { checked: false }, searchMemory: async () => [], onStepAdvance: () => {}, onPlanBlocked: () => {}, onToolCall: () => {} };

    await executeAgentTool('read_file', { filepath: 'a.js' }, ctx);
    await executeAgentTool('run_verify', {}, ctx);
    const out = await executeAgentTool('mark_step_done', { result: 'reviewed' }, ctx);

    assert.equal(plan.currentStepId, 2, `step should advance; got "${String(out).slice(0, 80)}"`);
    assert.equal(plan.steps[0].status, 'done');
});

// ===========================================================================
// A1: the execution turn budget must scale to the size of the plan, not the
// small chat "Thinking Steps" slider, so multi-step builds can finish.
// ===========================================================================
function installScriptedModel(disk, scriptFn) {
    global.window = { api: makeApi(disk) };
    let turn = 0;
    global.fetch = async () => {
        const tc = scriptFn(turn);
        turn++;
        const sse =
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + turn, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] } }] })}\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n` +
            `data: [DONE]\n`;
        const bytes = new TextEncoder().encode(sse);
        let sent = false;
        return { ok: true, status: 200, body: { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) } };
    };
    return () => turn;
}

function baseExecCtx(disk, plan, extra = {}) {
    return Object.assign({
        api: global.window.api, plan, userGoal: plan.goal, model: 'm',
        currentApiBase: 'http://localhost:1234', numCtx: 8192, temperature: 0.5,
        memoryToggle: { checked: false }, searchMemory: async () => [], saveToMemory: async () => ({}),
        envContext: '', chatHistory: [], autoGitCommit: false,
        onStepUpdate: () => {}, onStepAdvance: () => {}, onPlanBlocked: () => {}, onToolCall: () => {},
        onDelta: () => {}, onMessage: () => {},
    }, extra);
}

function multiStepPlan(n) {
    return {
        id: 'p1', goal: 'build', status: 'executing', verifyPolicy: 'block', projectRoot: '/proj',
        testCmd: null, lintCmd: null,
        steps: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: 'step ' + (i + 1), status: i === 0 ? 'active' : 'pending', result: '', filesTouched: [], verifiedAt: null })),
        currentStepId: 1, filesLedger: {}, decisions: [], scratchpad: '', activeFiles: [],
    };
}

test('A1: a 4-step plan completes even though maxSteps slider is only 3', async () => {
    const disk = { plan: null };
    const plan = multiStepPlan(4);
    disk.plan = JSON.parse(JSON.stringify(plan));
    // model alternates: write a file, then mark the step done (2 turns/step => 8 turns)
    installScriptedModel(disk, (turn) => (turn % 2 === 0)
        ? { name: 'write_file', arguments: { filepath: `f${turn}.txt`, content: 'x' } }
        : { name: 'mark_step_done', arguments: { result: 'ok' } });

    const ctx = baseExecCtx(disk, plan, { maxSteps: 3 }); // small chat slider value
    const final = await runExecutionPhase(ctx);

    assert.equal(final.status, 'done', `plan should finish all 4 steps; ended on step ${final.currentStepId}`);
    assert.ok(final.steps.every(s => s.status === 'done'), 'every step done');
});

test('A1: hitting the turn budget halts with a notice instead of silently freezing', async () => {
    const disk = { plan: null };
    const plan = multiStepPlan(1);
    disk.plan = JSON.parse(JSON.stringify(plan));
    // model makes progress every turn (new file) but never marks the step done
    installScriptedModel(disk, (turn) => ({ name: 'write_file', arguments: { filepath: `f${turn}.txt`, content: 'x' } }));

    let halted = '';
    const ctx = baseExecCtx(disk, plan, { maxSteps: 0, turnsPerStep: 3, onMessage: (t) => { halted = t; } });
    const final = await runExecutionPhase(ctx);

    assert.ok(/budget|halt/i.test(halted), `user should be notified on budget halt; got "${halted}"`);
    assert.ok(/\[HALTED\]/.test(final.scratchpad || ''), 'halt recorded on the plan scratchpad');
});

// ===========================================================================
// A4: apply_edits must record the files it changed on the plan (filesTouched +
// filesLedger) and persist, like edit_file/apply_patch — otherwise the agent
// loses sight of files it just batch-edited and the change isn't tracked.
// ===========================================================================
test('A4: apply_edits records edited files on the plan and saves', async () => {
    const disk = { plan: null };
    const plan = {
        id: 'p1', goal: 'g', status: 'executing', verifyPolicy: 'off',
        steps: [{ id: 1, title: 'edit', status: 'active', result: '', filesTouched: [], verifiedAt: null }],
        currentStepId: 1, filesLedger: {}, decisions: [], scratchpad: '', activeFiles: [],
    };
    disk.plan = JSON.parse(JSON.stringify(plan));
    let saves = 0;
    const api = {
        async invoke(channel, ...args) {
            if (channel === 'edit-apply-batch') {
                return {
                    success: true, results: [
                        { filepath: 'src/a.js', result: { success: true, relPath: 'src/a.js', created: false } },
                        { filepath: 'src/b.js', result: { success: true, relPath: 'src/b.js', created: false } },
                    ]
                };
            }
            if (channel === 'plan-save') { saves++; disk.plan = JSON.parse(JSON.stringify(args[0])); return { success: true }; }
            return { success: true };
        }
    };
    const ctx = { api, plan, memoryToggle: { checked: false }, searchMemory: async () => [], onStepAdvance: () => {}, onToolCall: () => {} };

    await executeAgentTool('apply_edits', { edits: [{ filepath: 'src/a.js', find: 'x', replace: 'y' }, { filepath: 'src/b.js', find: 'p', replace: 'q' }] }, ctx);

    const step = plan.steps[0];
    assert.ok(step.filesTouched.includes('src/a.js') && step.filesTouched.includes('src/b.js'), 'both files tracked on the step');
    assert.ok(plan.filesLedger['src/a.js'] && plan.filesLedger['src/b.js'], 'both files recorded in filesLedger');
    assert.ok(saves >= 1, 'plan persisted after batch edits');
});

// ===========================================================================
// A2: a file the agent is actively editing should be shown in full when it fits
// the context budget, not head/tail truncated (which makes mid-file edits blind).
// ===========================================================================
test('A2: an active file under budget is included in full, not truncated', async () => {
    const content = 'X'.repeat(12000); // exceeds the old 6000-char active-file cap
    const api = {
        async invoke(ch) {
            if (ch === 'agent-read-file') return { content };
            if (ch === 'agent-get-repo-map') return { map: '' };
            return {};
        }
    };
    const plan = {
        goal: 'g', projectType: 'brownfield', activeFiles: ['big.js'], filesLedger: {}, decisions: [], scratchpad: '',
        steps: [{ id: 1, title: 'edit big.js', status: 'active', filesTouched: [], verifiedAt: null }],
        currentStepId: 1, verifyPolicy: 'off',
    };
    const msgs = await buildExecutionContext({ api, plan, currentStep: plan.steps[0], numCtx: 16384, recentTurns: [], chatHistory: [] });
    const filesMsg = msgs.find(m => typeof m.content === 'string' && m.content.includes('[PROJECT FILES]'));
    assert.ok(filesMsg, 'project files block present');
    assert.ok(!/truncated/.test(filesMsg.content), 'active file should not be truncated when it fits the budget');
    assert.ok(filesMsg.content.includes(content), 'full active-file content present');
});

// ===========================================================================
// A6: long tool output (e.g. a failing test run) must keep its TAIL — the error
// and failing assertion are usually at the end, and head-only truncation hid them.
// ===========================================================================
test('A6: long tool output preserves the tail so trailing errors survive', async () => {
    const api = {
        async invoke(ch) {
            if (ch === 'agent-get-repo-map') return { map: '' };
            if (ch === 'agent-read-file') return { content: '' };
            return {};
        }
    };
    const plan = {
        goal: 'g', activeFiles: [], filesLedger: {}, decisions: [], scratchpad: '',
        steps: [{ id: 1, title: 's', status: 'active', filesTouched: [], verifiedAt: null }],
        currentStepId: 1, verifyPolicy: 'off',
    };
    const receipt = '[run_verify]\n' + 'A'.repeat(9000) + '\nFAIL: assertion ERROR_AT_END';
    const msgs = await buildExecutionContext({ api, plan, currentStep: plan.steps[0], numCtx: 16384, recentTurns: [], lastToolReceipt: receipt, chatHistory: [] });
    const to = msgs.find(m => typeof m.content === 'string' && m.content.includes('[LAST TOOL OUTPUT]'));
    assert.ok(to, 'last tool output block present');
    assert.ok(to.content.includes('ERROR_AT_END'), 'trailing error must be preserved in the tool output');
});

// ===========================================================================
// A7: the agent should retain a deeper working window of recent turns.
// ===========================================================================
test('A7: trimRecentTurns keeps a deeper working window than 6', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 't' + i }));
    const out = trimRecentTurns(turns);
    assert.ok(out.length >= 12, `should keep >=12 turns, kept ${out.length}`);
    assert.equal(out[out.length - 1].content, 't29', 'most recent turn retained');
    assert.equal(trimRecentTurns(turns.slice(0, 8)).length, 8, 'small histories pass through unchanged');
});

// ===========================================================================
// A8: a single deliberate repeat of the same tool (e.g. re-running tests) must
// be allowed, not flagged as an infinite loop and skipped.
// ===========================================================================
test('A8: one identical repeated tool call is executed, not skipped as a loop', async () => {
    const disk = { plan: null };
    const plan = multiStepPlan(1);
    plan.verifyPolicy = 'off';
    disk.plan = JSON.parse(JSON.stringify(plan));
    installScriptedModel(disk, (turn) => (turn < 2)
        ? { name: 'run_shell_command', arguments: { command: 'npm test' } }   // same call twice
        : { name: 'mark_step_done', arguments: { result: 'ok' } });
    let cmdRuns = 0;
    const inner = global.window.api.invoke.bind(global.window.api);
    global.window.api.invoke = async (ch, ...a) => { if (ch === 'agent-run-command') cmdRuns++; return inner(ch, ...a); };

    const ctx = baseExecCtx(disk, plan, { maxSteps: 50, verifyPolicy: 'off' });
    await runExecutionPhase(ctx);

    assert.ok(cmdRuns >= 2, `the repeated command should execute both times, ran ${cmdRuns}`);
});

// ===========================================================================
// A9: a git checkpoint is made after EACH completed step, not only at the end.
// ===========================================================================
test('A9: a git commit is made after each completed step', async () => {
    const disk = { plan: null };
    const plan = multiStepPlan(3);
    plan.verifyPolicy = 'off';
    disk.plan = JSON.parse(JSON.stringify(plan));
    installScriptedModel(disk, (turn) => (turn % 2 === 0)
        ? { name: 'write_file', arguments: { filepath: `f${turn}.txt`, content: 'x' } }
        : { name: 'mark_step_done', arguments: { result: 'ok' } });
    let commits = 0;
    const inner = global.window.api.invoke.bind(global.window.api);
    global.window.api.invoke = async (ch, ...a) => { if (ch === 'git-commit') commits++; return inner(ch, ...a); };

    const ctx = baseExecCtx(disk, plan, { maxSteps: 50, autoGitCommit: true });
    await runExecutionPhase(ctx);

    assert.equal(commits, 3, `expected one commit per completed step, got ${commits}`);
});

// ===========================================================================
// A10 (regression): an INTERMEDIATE step must verify with syntaxOnly, so a
// failing test command (expected on half-finished code) does NOT block it.
// This guards the bug where the agent-verify IPC dropped the {syntaxOnly}
// option and ran the full test suite on every intermediate mark_step_done.
// ===========================================================================
test('A10: intermediate step advances under a failing testCmd (syntaxOnly), not blocked', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const verificationHarness = require('../lib/verificationHarness.js');

    const root = path.join(os.tmpdir(), `xk-verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(root, { recursive: true });

    const disk = { plan: null };
    const plan = {
        id: 'pv', goal: 'build', status: 'executing', verifyPolicy: 'block', projectRoot: root,
        // A test command that ALWAYS fails — mimics red tests on a partial build.
        testCmd: 'node -e "process.exit(1)"', lintCmd: null,
        steps: [
            { id: 1, title: 'step 1', status: 'active', result: '', filesTouched: [], verifiedAt: null },
            { id: 2, title: 'step 2', status: 'pending', result: '', filesTouched: [], verifiedAt: null },
        ],
        currentStepId: 1, filesLedger: {}, decisions: [], scratchpad: '', activeFiles: [],
    };
    disk.plan = JSON.parse(JSON.stringify(plan));

    // API that mirrors the REAL main.js handlers: agent-write-file writes to disk,
    // and agent-verify forwards the per-call opts (args[1]) into the real harness.
    const api = {
        async invoke(channel, ...args) {
            if (channel === 'plan-save') { disk.plan = JSON.parse(JSON.stringify(args[0])); return { success: true }; }
            if (channel === 'plan-load') { return JSON.parse(JSON.stringify(disk.plan)); }
            if (channel === 'agent-write-file') {
                const [filepath, content] = args;
                fs.writeFileSync(path.join(root, filepath), content, 'utf-8');
                return { success: true, path: filepath, created: true };
            }
            if (channel === 'agent-verify') {
                const p = JSON.parse(JSON.stringify(disk.plan));
                const result = await verificationHarness.runVerification(root, p, args[1] || {});
                if (result.ok && !result.unverified && p.currentStepId) {
                    verificationHarness.markStepVerified(p, p.currentStepId);
                    disk.plan = JSON.parse(JSON.stringify(p));
                }
                return { ...result, plan: p };
            }
            if (channel === 'agent-get-repo-map') return { map: '' };
            if (channel === 'project-get-root') return { projectRoot: root };
            return { success: true };
        }
    };
    global.window = { api };

    let turn = 0;
    global.fetch = async () => {
        // Write a uniquely-named VALID js file, then mark the step done.
        const tc = (turn % 2 === 0)
            ? { name: 'write_file', arguments: { filepath: `f${turn}.js`, content: 'module.exports = ' + turn + ';\n' } }
            : { name: 'mark_step_done', arguments: { result: 'ok' } };
        turn++;
        const sse =
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + turn, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] } }] })}\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n` +
            `data: [DONE]\n`;
        const bytes = new TextEncoder().encode(sse);
        let sent = false;
        return { ok: true, status: 200, body: { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) } };
    };

    const ctx = baseExecCtx(disk, plan, { api, maxSteps: 0, turnsPerStep: 5, autoGitCommit: false });
    const final = await runExecutionPhase(ctx);

    // Step 1 is intermediate (step 2 still pending), so it must verify via syntaxOnly
    // and complete despite the failing testCmd.
    assert.equal(final.steps[0].status, 'done', 'intermediate step 1 should complete under syntaxOnly');
    assert.ok(final.currentStepId !== 1, 'execution should have advanced past the intermediate step');
});

// ===========================================================================
// Repair hints: verify failure should include structured repair targets.
// ===========================================================================
test('verify failure on mark_step_done includes repair hints', async () => {
    const disk = { plan: null };
    const plan = {
        id: 'pr', goal: 'build cli', status: 'executing', verifyPolicy: 'block',
        steps: [
            { id: 1, title: 'implement cli', status: 'active', result: '', filesTouched: [], verifiedAt: null, activityCount: 2 },
        ],
        currentStepId: 1, filesLedger: {}, decisions: [], scratchpad: '', activeFiles: [],
    };
    disk.plan = JSON.parse(JSON.stringify(plan));
    const api = {
        async invoke(channel, ...args) {
            if (channel === 'plan-save') { disk.plan = JSON.parse(JSON.stringify(args[0])); return { success: true }; }
            if (channel === 'plan-load') { return JSON.parse(JSON.stringify(disk.plan)); }
            if (channel === 'agent-verify') {
                return {
                    ok: false,
                    messages: ["ModuleNotFoundError: No module named 'nanobot.__main__'"],
                    plan: JSON.parse(JSON.stringify(disk.plan))
                };
            }
            return { success: true };
        }
    };
    const ctx = { api, plan: JSON.parse(JSON.stringify(plan)) };
    const out = await executeAgentTool('mark_step_done', { result: 'done' }, ctx);
    assert.match(out, /REPAIR TARGETS/);
    assert.match(out, /__main__\.py/);
});

test('detectModelFamily picks qwen and llama families', () => {
    const { detectModelFamily } = require('../contextBuilder.js');
    assert.equal(detectModelFamily('qwen2.5-coder-7b'), 'qwen');
    assert.equal(detectModelFamily('meta-llama-3.1-8b'), 'llama');
    assert.equal(detectModelFamily('gemma-4-e4b'), 'llama');
});
