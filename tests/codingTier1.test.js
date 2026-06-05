const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ctx = require('../contextBuilder.js');
const vh = require('../lib/verificationHarness.js');
const editFormats = require('../lib/editFormats.js');
const EditEngine = require('../editEngine.js');
const memory = require('../memory.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xk-t1-')); }

// ---- contextBuilder: line numbers + honest truncation ----------------------

test('numberLines: prefixes each line with a padded number', () => {
    const { text, lineCount } = ctx.numberLines('a\nb\nc');
    assert.strictEqual(lineCount, 3);
    assert.strictEqual(text, '1\ta\n2\tb\n3\tc');
});

test('readFileExcerpt: numbers lines and, on overflow, keeps a contiguous head + omission notice (no tail)', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line_${i + 1}_ZZZ`).join('\n');
    const api = { invoke: async () => ({ content: big }) };
    const out = await ctx.readFileExcerpt(api, 'f.js', 400);
    assert.ok(out.startsWith('  1\t') || out.startsWith('1\t'), 'starts at line 1, numbered');
    assert.ok(out.includes('omitted — use read_file'), 'states the omission honestly');
    // The LAST source line must NOT appear (we keep head only, never tail).
    assert.ok(!out.includes('line_200_ZZZ'), 'does not splice the file tail in');
});

test('fitMessages: trims from the end but never drops message 0', () => {
    const msgs = [
        { role: 'system', content: 'X'.repeat(100) },
        { role: 'user', content: 'Y'.repeat(100) },
        { role: 'user', content: 'Z'.repeat(100) },
    ];
    const out = ctx.fitMessages(msgs, 150);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].role, 'system');
});

test('buildExecutionContext: the plan digest is message 0 and survives a tiny num_ctx', async () => {
    const api = { invoke: async (ch) => (ch === 'agent-get-repo-map' ? {} : { content: '' }) };
    const plan = {
        goal: 'BUILD_THE_THING_UNIQUE_GOAL',
        steps: [{ id: 1, title: 'step one', status: 'active' }],
        filesLedger: {}, activeFiles: [], decisions: [],
    };
    const messages = await ctx.buildExecutionContext({
        api, plan, currentStep: plan.steps[0], numCtx: 80,
        recentTurns: [{ role: 'user', content: 'NOISE '.repeat(500) }],
    });
    assert.strictEqual(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('BUILD_THE_THING_UNIQUE_GOAL'), 'digest/goal preserved');
});

// ---- verification: per-language + honest unverified -------------------------

test('syntaxCheckFile: catches a JS syntax error and passes valid JS', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'bad.js'), 'function (');
    fs.writeFileSync(path.join(d, 'ok.js'), 'const x = 1;\n');
    assert.strictEqual((await vh.runVerification(d, { filesLedger: { 'ok.js': {} } })).ok, true);
    const bad = await vh.runVerification(d, { filesLedger: { 'bad.js': {} } });
    assert.strictEqual(bad.ok, false);
});

test('runVerification: a touched non-checkable file yields unverified (NOT a false verified)', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'notes.txt'), 'hello'); // unsupported extension
    const r = await vh.runVerification(d, { filesLedger: { 'notes.txt': {} } });
    assert.strictEqual(r.ok, true, 'allowed through');
    assert.strictEqual(r.unverified, true, 'but honestly marked unverified');
    assert.ok(r.messages.some(m => m.includes('UNVERIFIED')));
});

test('runVerification: valid JSON passes, broken JSON fails', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'a.json'), '{"x":1}');
    fs.writeFileSync(path.join(d, 'b.json'), '{ not json');
    assert.strictEqual((await vh.runVerification(d, { filesLedger: { 'a.json': {} } })).ok, true);
    assert.strictEqual((await vh.runVerification(d, { filesLedger: { 'b.json': {} } })).ok, false);
});

// ---- edit engine: CRLF + BOM preservation, LF find matches CRLF -------------

function makeEngine() {
    const ledger = { snapshotBefore: async () => {}, recordCreate: async () => {} };
    let lastRoot = null;
    const projectContext = {
        resolvePath: (p) => ({ path: p }),
        establishFromFilePath: (p) => { lastRoot = p; },
    };
    return new EditEngine(ledger, projectContext);
}

test('editEngine.apply: an LF find-block matches a CRLF+BOM file and the EOL/BOM are preserved', async () => {
    const d = tmpDir();
    const file = path.join(d, 'crlf.js');
    const BOM = String.fromCharCode(0xFEFF);
    const original = BOM + ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\r\n') + '\r\n';
    fs.writeFileSync(file, original, 'utf-8');

    const engine = makeEngine();
    // find is supplied with LF endings (what a model emits) against a CRLF file.
    const r = await engine.apply('p1', file, 'const b = 2;', 'const b = 22;');
    assert.strictEqual(r.success, true, r.error || 'should apply');

    const after = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(after.charCodeAt(0), 0xFEFF, 'BOM preserved');
    assert.ok(after.includes('const b = 22;'), 'edit applied');
    assert.ok(after.includes('\r\n'), 'CRLF preserved');
    assert.ok(!/[^\r]\n/.test(after.slice(1)), 'no lone LF introduced');
});

test('editEngine.apply: a plain LF file stays LF (no CRLF introduced)', async () => {
    const d = tmpDir();
    const file = path.join(d, 'lf.js');
    fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n', 'utf-8');
    const engine = makeEngine();
    await engine.apply('p1', file, 'const a = 1;', 'const a = 11;');
    const after = fs.readFileSync(file, 'utf-8');
    assert.ok(!after.includes('\r\n'), 'no CRLF introduced into an LF file');
    assert.ok(after.includes('const a = 11;'));
});

test('editEngine.applyPatch: an LF unified diff applies to a CRLF+BOM file and EOL/BOM are preserved', async () => {
    const d = tmpDir();
    const file = path.join(d, 'crlf-patch.js');
    const BOM = String.fromCharCode(0xFEFF);
    const original = BOM + ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\r\n') + '\r\n';
    fs.writeFileSync(file, original, 'utf-8');

    const engine = makeEngine();
    // A model-emitted unified diff uses LF; the file on disk is CRLF+BOM.
    const patch = [
        '--- a/crlf-patch.js',
        '+++ b/crlf-patch.js',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 22;',
        ' const c = 3;',
    ].join('\n');

    const r = await engine.applyPatch('p1', file, patch);
    assert.strictEqual(r.success, true, r.error || 'patch should apply to a CRLF file');

    const after = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(after.charCodeAt(0), 0xFEFF, 'BOM preserved');
    assert.ok(after.includes('const b = 22;'), 'patch applied');
    assert.ok(after.includes('\r\n'), 'CRLF preserved');
    assert.ok(!/[^\r]\n/.test(after.slice(1)), 'no lone LF introduced');
});

// ---- editFormats: tolerant window scales to the find block ------------------

test('applySearchReplace: a find block longer than 40 lines can still match', () => {
    const block = Array.from({ length: 50 }, (_, i) => `  x${i} = ${i};`).join('\n');
    const content = 'function f() {\n' + block + '\n}\n';
    // Re-indented find (whitespace differs) so only the tolerant path can match.
    const find = block.replace(/^\s+/gm, '');
    const r = editFormats.applySearchReplace(content, find, 'REPLACED');
    assert.ok(!r.error, r.error);
    assert.ok(r.content.includes('REPLACED'));
});

// ---- memory: similarity floor ----------------------------------------------

test('memory.filterByFloor: drops hits below the relevance floor', () => {
    const rows = [{ similarity: 0.9, text: 'a' }, { similarity: 0.2, text: 'b' }, { similarity: 0.5, text: 'c' }];
    const kept = memory.filterByFloor(rows, 0.4).map(r => r.text);
    assert.deepStrictEqual(kept, ['a', 'c']);
});
