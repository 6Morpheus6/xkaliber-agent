/**
 * Structured repair hints from verifier output.
 * Ported from the Nanocode counterexample extractors idea: turn raw test/syntax
 * output into concrete, actionable repair targets instead of dumping stderr.
 */

function missingEntrypoint(output) {
    const quoted = /No module named ['"]([^'"]+\.__main__)['"]/i.exec(output);
    const bare = /No module named ([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.__main__/i.exec(output);
    const m = quoted || bare;
    if (!m) return null;
    const pkg = m[1].replace(/\.__main__$/, '');
    const packagePath = pkg.replace(/\./g, '/');
    return `Create ${packagePath}/__main__.py so \`python -m ${pkg}\` can run the CLI.`;
}

function missingModule(output) {
    const m = /No module named '?([A-Za-z_][\w.]*)'?/i.exec(output);
    if (!m || /__main__/.test(m[0])) return null;
    const mod = m[1];
    const modPath = mod.replace(/\./g, '/');
    return `Module \`${mod}\` is missing — create ${modPath}.py (and package __init__.py files on the path) with real implementations, not stubs.`;
}

function missingExport(output) {
    const m = /cannot import name '?([A-Za-z_]\w*)'?(?: from '?([A-Za-z_][\w.]*)'?)?(?:\s*\(([^)]+)\))?/i.exec(output);
    if (!m) return null;
    const symbol = m[1];
    const mod = m[2];
    const file = m[3];
    const where = file || (mod ? `${mod.replace(/\./g, '/')}.py` : 'the target module');
    return `Export \`${symbol}\` from ${where} — the test imports it but it is not defined at module scope.`;
}

function assertionMismatch(output) {
    const m = /AssertionError:\s*(.+)/i.exec(output);
    if (m) return `Assertion failed: ${m[1].trim().slice(0, 200)} — fix the implementation so the test passes.`;
    const py = /assert\s+.+\s+==\s+.+/i.test(output) && /FAILED|Error|!=/i.test(output);
    if (py) {
        const lines = output.split('\n').filter(l => /!=|AssertionError|assert/i.test(l)).slice(0, 3);
        if (lines.length) return `Test assertion mismatch:\n${lines.join('\n')}`;
    }
    return null;
}

function syntaxError(output) {
    const m = /SyntaxError[^\n]*\n[^\n]*/i.exec(output) || /Error:\s*[^\n]*syntax[^\n]*/i.exec(output);
    if (m) return `Syntax error — fix before continuing:\n${m[0].trim().slice(0, 300)}`;
    return null;
}

const MATCHERS = [
    missingEntrypoint,
    missingModule,
    missingExport,
    assertionMismatch,
    syntaxError,
];

/**
 * @param {string} output - combined verifier stdout/stderr or messages
 * @returns {string[]} concrete repair hints, highest-signal first
 */
function extractRepairHints(output) {
    if (!output || !String(output).trim()) return [];
    const text = String(output);
    const hints = [];
    const seen = new Set();
    for (const fn of MATCHERS) {
        const h = fn(text);
        if (h && !seen.has(h)) {
            seen.add(h);
            hints.push(h);
        }
    }
    return hints;
}

/**
 * @param {string} output
 * @returns {string} block to append to mark_step_done failure tool result
 */
function formatRepairBlock(output) {
    const hints = extractRepairHints(output);
    if (!hints.length) return '';
    return '\n\nREPAIR TARGETS (from verification output):\n' +
        hints.map((h, i) => `${i + 1}. ${h}`).join('\n') +
        '\n\nDiagnose the root cause, make a targeted edit, re-run the failing command, then mark_step_done again.';
}

const exports_ = { extractRepairHints, formatRepairBlock };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports_;
}
if (typeof window !== 'undefined') {
    window.XKRepairHints = exports_;
}
