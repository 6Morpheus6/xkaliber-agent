const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PlanStore = require('../planStore.js');
const vh = require('../lib/verificationHarness.js');
const editFormats = require('../lib/editFormats.js');
const memory = require('../memory.js');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xk-t2-'));
}

// ---- A. planStore.addSteps -------------------------------------------------

test('planStore.addSteps: appends pending steps with continuing ids', () => {
    const ps = new PlanStore(os.tmpdir(), {});
    const plan = {
        steps: [{ id: 1, title: 'one', status: 'done' }, { id: 2, title: 'two', status: 'active' }],
        currentStepId: 2, status: 'executing',
    };
    const added = ps.addSteps(plan, ['three', 'four']);
    assert.strictEqual(added.length, 2);
    assert.deepStrictEqual(added.map(s => s.id), [3, 4]);
    assert.strictEqual(plan.steps.length, 4);
    assert.strictEqual(plan.steps[2].status, 'pending');
});

test('planStore.addSteps: re-activates a plan that had run out of steps', () => {
    const ps = new PlanStore(os.tmpdir(), {});
    const plan = { steps: [{ id: 1, title: 'one', status: 'done' }], currentStepId: null, status: 'done' };
    const added = ps.addSteps(plan, ['recovered work']);
    assert.strictEqual(plan.status, 'executing');
    assert.strictEqual(plan.currentStepId, added[0].id);
    assert.strictEqual(added[0].status, 'active');
});

test('planStore.addSteps: ignores empty titles', () => {
    const ps = new PlanStore(os.tmpdir(), {});
    const plan = { steps: [{ id: 1, title: 'one', status: 'active' }], currentStepId: 1, status: 'executing' };
    const added = ps.addSteps(plan, ['', '   ', 'real']);
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].title, 'real');
});

// ---- B. syntaxOnly verification --------------------------------------------

test('runVerification syntaxOnly: skips test/lint, still catches a syntax error', async () => {
    const d = tmpProject();
    fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(d, 'bad.js'), 'function (\n');

    // A test command that would FAIL is NOT run in syntaxOnly mode.
    const okPlan = { testCmd: 'exit 1', lintCmd: null, filesLedger: { 'ok.js': {} } };
    const r = await vh.runVerification(d, okPlan, { syntaxOnly: true });
    assert.strictEqual(r.ok, true, 'valid syntax passes; failing test command not run');

    // A real syntax error still fails under syntaxOnly.
    const badPlan = { testCmd: null, lintCmd: null, filesLedger: { 'bad.js': {} } };
    const rb = await vh.runVerification(d, badPlan, { syntaxOnly: true });
    assert.strictEqual(rb.ok, false, 'syntax error caught');
});

test('runVerification (full): a failing test command does fail (final step path)', async () => {
    const d = tmpProject();
    fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;\n');
    const plan = { testCmd: 'exit 1', lintCmd: null, filesLedger: { 'ok.js': {} } };
    const r = await vh.runVerification(d, plan); // no syntaxOnly -> runs the test
    assert.strictEqual(r.ok, false, 'final-step verification runs the test suite');
});

// ---- E. unified-diff applier fails loudly ----------------------------------

test('applyPatchToFile: a non-matching context line returns an error (no silent corruption)', () => {
    const original = 'line1\nline2\nline3\n';
    const patch = '--- a/f.js\n+++ b/f.js\n@@ -1,1 +1,1 @@\n-nonexistent line\n+replacement\n';
    const r = editFormats.applyPatchToFile(original, patch);
    assert.ok(r.error, 'should report an error');
    assert.ok(/not found/i.test(r.error));
});

test('applyPatchToFile: a matching patch still applies cleanly (regression)', () => {
    const original = 'line1\nline2\nline3\n';
    const patch = '--- a/f.js\n+++ b/f.js\n@@ -2,1 +2,1 @@\n-line2\n+LINE2X\n';
    const r = editFormats.applyPatchToFile(original, patch);
    assert.ok(!r.error, r.error);
    assert.ok(r.content.includes('LINE2X'));
    assert.ok(r.content.includes('line1') && r.content.includes('line3'), 'other lines preserved');
});

// ---- G. embeddings fallback wiring -----------------------------------------

test('memory.setLlmBase + openAiEmbed: returns null without a base and on an unreachable base', async () => {
    memory.setLlmBase(null);
    assert.strictEqual(await memory.openAiEmbed('hello'), null, 'no base -> null');
    memory.setLlmBase('http://127.0.0.1:1'); // nothing listening -> connection refused
    assert.strictEqual(await memory.openAiEmbed('hello'), null, 'unreachable base -> null (no throw)');
    memory.setLlmBase(null);
});
