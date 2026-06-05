const path = require('path');

function normalizeRel(projectRoot, input) {
    const cleaned = String(input || '').trim().replace(/^@/, '');
    if (!cleaned) return null;
    return cleaned.replace(/\\/g, '/');
}

function addFiles(plan, paths, projectRoot) {
    if (!plan.activeFiles) plan.activeFiles = [];
    if (!plan.readOnlyFiles) plan.readOnlyFiles = [];
    for (const p of paths) {
        const rel = normalizeRel(projectRoot, p);
        if (!rel) continue;
        if (!plan.activeFiles.includes(rel) && !plan.readOnlyFiles.includes(rel)) {
            plan.activeFiles.push(rel);
        }
    }
    return plan;
}

function dropFiles(plan, paths) {
    if (!plan.activeFiles) return plan;
    const drop = new Set(paths.map(p => normalizeRel(null, p)).filter(Boolean));
    plan.activeFiles = plan.activeFiles.filter(f => !drop.has(f));
    plan.readOnlyFiles = (plan.readOnlyFiles || []).filter(f => !drop.has(f));
    return plan;
}

function parseMentionsFromText(text, projectRoot) {
    const found = [];
    const atPath = /@[\w./\\-]+\.\w+/g;
    let m;
    while ((m = atPath.exec(text)) !== null) {
        found.push(m[0].slice(1));
    }
    const bare = /\b[\w.-]+\.(js|ts|tsx|jsx|py|json|md|html|css)\b/gi;
    while ((m = bare.exec(text)) !== null) {
        found.push(m[0]);
    }
    return [...new Set(found)];
}

function allActivePaths(plan) {
    return [...(plan.activeFiles || []), ...(plan.readOnlyFiles || [])];
}

module.exports = { addFiles, dropFiles, parseMentionsFromText, allActivePaths, normalizeRel };
