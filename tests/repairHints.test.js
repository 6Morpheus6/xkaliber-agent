const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRepairHints, formatRepairBlock } = require('../lib/repairHints');

test('missing __main__ entrypoint (quoted python error)', () => {
    const out = "ModuleNotFoundError: No module named 'nanobot.__main__'";
    const hints = extractRepairHints(out);
    assert.ok(hints.some(h => h.includes('__main__.py')));
});

test('missing module file', () => {
    const out = "ModuleNotFoundError: No module named 'nanobot.cli'";
    const hints = extractRepairHints(out);
    assert.ok(hints.some(h => h.includes('nanobot/cli.py')));
});

test('missing export', () => {
    const out = "ImportError: cannot import name 'Assistant' from 'nanobot' (/tmp/nanobot/__init__.py)";
    const hints = extractRepairHints(out);
    assert.ok(hints.some(h => h.includes('Assistant')));
});

test('assertion failure', () => {
    const out = "AssertionError: 'UTC' != 'PST'\nFAILED (failures=1)";
    const hints = extractRepairHints(out);
    assert.ok(hints.length > 0);
});

test('formatRepairBlock returns empty for unparseable output', () => {
    assert.equal(formatRepairBlock('something vague happened'), '');
});

test('formatRepairBlock includes numbered targets', () => {
    const block = formatRepairBlock("No module named foo.__main__");
    assert.match(block, /REPAIR TARGETS/);
    assert.match(block, /__main__\.py/);
});
