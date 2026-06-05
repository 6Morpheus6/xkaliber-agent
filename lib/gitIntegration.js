const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

function gitExec(cwd, args) {
    return new Promise((resolve) => {
        const cmd = `git ${args.join(' ')}`;
        exec(cmd, { cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
                error: error ? error.message : null
            });
        });
    });
}

function isRepo(projectRoot) {
    return fs.existsSync(path.join(projectRoot, '.git'));
}

async function init(projectRoot) {
    if (isRepo(projectRoot)) return { ok: true, already: true };
    return gitExec(projectRoot, ['init']);
}

async function status(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['status', '--porcelain']);
}

async function diff(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    return gitExec(projectRoot, ['diff', '--stat']);
}

async function commit(projectRoot, message) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    await gitExec(projectRoot, ['add', '-A']);
    const safe = message.replace(/"/g, '\\"').slice(0, 500);
    return gitExec(projectRoot, ['commit', '-m', `"${safe}"`, '--allow-empty']);
}

async function undoLast(projectRoot) {
    if (!isRepo(projectRoot)) return { ok: false, error: 'not a git repo' };
    const log = await gitExec(projectRoot, ['rev-parse', 'HEAD']);
    if (!log.ok) return log;
    const parent = await gitExec(projectRoot, ['rev-parse', 'HEAD~1']);
    if (!parent.ok) {
        return gitExec(projectRoot, ['update-ref', '-d', 'HEAD']);
    }
    return gitExec(projectRoot, ['reset', '--hard', 'HEAD~1']);
}

async function logOneline(projectRoot, n = 10) {
    if (!isRepo(projectRoot)) return { ok: false, lines: [] };
    const res = await gitExec(projectRoot, ['log', `--oneline`, `-n`, String(n)]);
    return { ...res, lines: res.stdout ? res.stdout.split('\n') : [] };
}

module.exports = {
    isRepo,
    init,
    status,
    diff,
    commit,
    undoLast,
    logOneline,
    gitExec
};
