const { test } = require('node:test');
const assert = require('node:assert');
const agentLoop = require('../agentLoop.js');

// Regression for the "[BLOCKED step null] / 16 turns doing nothing" bug: a small
// model re-emitted submit_plan during execution, which recreated the plan with a
// null current step and stranded the build.

test('submit_plan is NOT offered in the execution tool set', () => {
    const names = agentLoop.EXECUTION_TOOLS.map(t => t.function.name);
    assert.ok(!names.includes('submit_plan'), 'execution must not offer submit_plan');
    // but the real edit/run tools are still there
    assert.ok(names.includes('write_file') && names.includes('edit_file') && names.includes('mark_step_done'));
});

test('submit_plan during execution is refused and does NOT recreate the plan', async () => {
    let createCalled = false, onCreatedCalled = false;
    const ctx = {
        plan: { status: 'executing', steps: [{ id: 1, title: 'x', status: 'active' }], currentStepId: 1, filesLedger: {} },
        api: { invoke: async (ch) => { if (ch === 'plan-create') createCalled = true; return {}; } },
        onPlanCreated: () => { onCreatedCalled = true; },
        userGoal: 'g',
    };
    const res = await agentLoop.executeAgentTool('submit_plan', { goal: 'g', steps: ['a'] }, ctx);
    assert.match(res, /already approved and executing/i);
    assert.strictEqual(createCalled, false, 'plan-create must not be called');
    assert.strictEqual(onCreatedCalled, false, 'plan must not be reset');
    assert.strictEqual(ctx.plan.currentStepId, 1, 'current step preserved');
});

test('add_files during planning (no plan yet) does NOT crash — it stashes the pins', async () => {
    const ctx = { plan: null, api: { invoke: async () => ({}) } };
    const res = await agentLoop.executeAgentTool('add_files', { paths: ['src/scanner.ts'] }, ctx);
    assert.match(res, /Noted 1 file/i);
    assert.deepStrictEqual(ctx.pendingActiveFiles, ['src/scanner.ts']);
});

test('Build Mode execution tools = coding only (non-coding tools excluded)', () => {
    const names = agentLoop.EXECUTION_TOOLS.map(t => t.function.name);
    for (const n of ['submit_plan', 'send_whatsapp_message', 'provide_file_download_link', 'dynamic_schema_generate', 'save_new_user_fact_only']) {
        assert.ok(!names.includes(n), `${n} must NOT be offered during a build`);
    }
    for (const n of ['write_file', 'edit_file', 'read_file', 'run_shell_command', 'run_verify', 'add_steps', 'add_files']) {
        assert.ok(names.includes(n), `${n} must be available during a build`);
    }
});

test('submit_plan during planning (no plan yet) still creates the plan', async () => {
    let createCalled = false;
    const ctx = {
        plan: null,
        api: {
            invoke: async (ch) => {
                if (ch === 'plan-create') { createCalled = true; return { success: true, plan: { id: 'p', status: 'awaiting_approval' } }; }
                return {};
            }
        },
        onPlanCreated: () => {},
        userGoal: 'g',
    };
    const res = await agentLoop.executeAgentTool('submit_plan', { goal: 'g', steps: ['a'] }, ctx);
    assert.strictEqual(createCalled, true, 'planning submit_plan still creates a plan');
    assert.match(res, /awaiting user approval/i);
});
