const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_REFLECTIONS = 3;

// Run one checker command. Distinguishes three outcomes so a missing tool is a
// SKIP (not a failure): { ran:false } = tool absent; { ran:true, ok:true } = passed;
// { ran:true, ok:false, message, raw } = real error.
function execCheck(cmd, timeout = 20000) {
    return new Promise((resolve) => {
        exec(cmd, { timeout }, (error, stdout, stderr) => {
            if (!error) return resolve({ ran: true, ok: true });
            const raw = (stderr || stdout || error.message || '').toString();
            // Tool not installed → treat as "couldn't check", never as a failure.
            if (error.code === 127 || /is not recognized|not recognized as|command not found|ENOENT|No such file/i.test(raw)) {
                return resolve({ ran: false });
            }
            if (error.killed) return resolve({ ran: true, ok: false, message: 'check timed out', raw });
            const message = raw.trim().split('\n').filter(Boolean).slice(-3).join(' ');
            resolve({ ran: true, ok: false, message, raw });
        });
    });
}

// Per-language syntax check for a single file, gated on the checker being installed
// (a missing checker is a skip, not a pass-claim). JS/JSON use the always-present
// bundled node runtime; other languages use their standard syntax checker if found.
async function syntaxCheckFile(projectRoot, relPath) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
    const ext = path.extname(abs).toLowerCase();
    const q = JSON.stringify(abs);

    if (ext === '.json') {
        try { JSON.parse(fs.readFileSync(abs, 'utf-8')); return { ok: true }; }
        catch (e) { return { ok: false, file: relPath, message: e.message }; }
    }

    // TypeScript per-file checking is noisy (cross-file module resolution), so only
    // genuine SYNTAX errors (TS1xxx) are treated as failures; everything else (e.g.
    // TS2307 cannot-find-module) is ignored to avoid false build-blocking.
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
        const jsx = ext === '.tsx' ? '--jsx react ' : '';
        const r = await execCheck(`tsc --noEmit --skipLibCheck --isolatedModules ${jsx}${q}`);
        if (!r.ran) return { ok: true, skipped: true, toolMissing: true };
        if (r.ok) return { ok: true };
        if (/error TS1\d{3}/.test(r.raw || '')) return { ok: false, file: relPath, message: r.message };
        return { ok: true, skipped: true };
    }

    const CHECKS = {
        '.js': [`node --check ${q}`],
        '.cjs': [`node --check ${q}`],
        '.mjs': [`node --check ${q}`],
        '.py': [`python -m py_compile ${q}`, `python3 -m py_compile ${q}`],
        '.go': [`gofmt -e ${q}`],
        '.rb': [`ruby -c ${q}`],
        '.php': [`php -l ${q}`],
    };
    const cmds = CHECKS[ext];
    if (!cmds) return { ok: true, skipped: true }; // unsupported extension

    for (const cmd of cmds) {
        const r = await execCheck(cmd);
        if (r.ran) return r.ok ? { ok: true } : { ok: false, file: relPath, message: r.message };
        // else tool missing → try the next candidate (e.g. python3)
    }
    return { ok: true, skipped: true, toolMissing: true }; // no checker installed
}

// Fallback gate when the project has no lint/test command: validate the syntax of
// the files this plan recently touched, so the agent can't "complete" a step that
// left broken code on disk.
async function syntaxCheckTouched(projectRoot, plan) {
    const rels = Object.keys(plan.filesLedger || {}).slice(-12);
    const messages = [];
    let ok = true, checked = 0;
    for (const rel of rels) {
        const r = await syntaxCheckFile(projectRoot, rel);
        if (r.skipped) continue;
        checked++;
        if (!r.ok) { ok = false; messages.push(`[SYNTAX] ${r.file}: ${r.message}`); }
    }
    return { ok, messages, checked };
}

function runCmd(cwd, command, timeoutMs = 120000) {
    return new Promise((resolve) => {
        exec(command, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                exitCode: error ? (error.code || 1) : 0,
                stdout: stdout || '',
                stderr: stderr || '',
                error: error ? error.message : null
            });
        });
    });
}

async function runVerification(projectRoot, plan, opts = {}) {
    const results = { lint: null, test: null, ok: true, messages: [] };

    // Per-step gating: intermediate steps run only the cheap syntax check (a syntax
    // error is never legitimate mid-build), deferring the full lint/test suite to the
    // final step so half-finished code isn't tested early.
    if (opts.syntaxOnly) {
        const sc = await syntaxCheckTouched(projectRoot, plan);
        results.syntax = sc;
        if (sc.checked > 0) {
            if (!sc.ok) { results.ok = false; results.messages.push(...sc.messages); }
        } else {
            results.unverified = true;
            results.messages.push('[UNVERIFIED] No syntax checker available for the touched files. Confirm correctness manually.');
        }
        return results;
    }

    if (plan.lintCmd) {
        results.lint = await runCmd(projectRoot, plan.lintCmd);
        if (!results.lint.ok) {
            results.ok = false;
            results.messages.push(`[LINT FAILED] ${plan.lintCmd}\n${results.lint.stderr || results.lint.stdout}`);
        }
    }

    if (plan.testCmd) {
        results.test = await runCmd(projectRoot, plan.testCmd);
        if (!results.test.ok) {
            results.ok = false;
            results.messages.push(`[TEST FAILED] ${plan.testCmd}\n${results.test.stderr || results.test.stdout}`);
        }
    }

    // No explicit verification configured → fall back to a syntax check of the
    // files this plan touched, so completion still has a real correctness signal.
    if (!plan.lintCmd && !plan.testCmd) {
        const sc = await syntaxCheckTouched(projectRoot, plan);
        results.syntax = sc;
        if (sc.checked > 0) {
            if (!sc.ok) {
                results.ok = false;
                results.messages.push(...sc.messages);
            }
        } else {
            // Nothing real could be checked (no test/lint command, and the touched
            // files are an unsupported language or their checker isn't installed).
            // Be HONEST: this is unverified, not verified. Callers must not stamp a
            // [verified] mark, but the step is still allowed through — we can't gate
            // on a check that can't run.
            results.unverified = true;
            results.messages.push('[UNVERIFIED] No automated verification available for the touched files (no test/lint command, and no syntax checker for their language). Confirm correctness manually.');
        }
    }

    return results;
}

function formatReflectionMessage(verifyResult) {
    return `[VERIFY FAILED]\n${verifyResult.messages.join('\n\n')}\n\nFix the issues and run tools again. Do not call mark_step_done until verification passes.`;
}

function canMarkStepDone(plan, stepId) {
    const step = plan.steps?.find(s => s.id === stepId);
    if (!step) return false;
    if (plan.verifyPolicy === 'off') return true;
    return Boolean(step.verifiedAt);
}

function markStepVerified(plan, stepId) {
    const step = plan.steps?.find(s => s.id === stepId);
    if (step) step.verifiedAt = Date.now();
    return plan;
}

module.exports = {
    runVerification,
    formatReflectionMessage,
    canMarkStepDone,
    markStepVerified,
    MAX_REFLECTIONS,
    runCmd
};
