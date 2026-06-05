#!/usr/bin/env node
/**
 * v50 ship criteria smoke check (no LM Studio required).
 * Run: node scripts/ship-check.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
process.chdir(root);

console.log('Xkaliber v50 ship-check\n');

execSync('npm test', { stdio: 'inherit' });

const { grepProject } = require('../lib/grepTool.js');
const { globFiles } = require('../lib/globTool.js');
const gitIntegration = require('../lib/gitIntegration.js');
const projectContext = require('../projectContext.js');
const ChangeLedger = require('../changeLedger.js');
const EditEngine = require('../editEngine.js');
const PlanStore = require('../planStore.js');

async function brownfield() {
    const dir = path.join(os.tmpdir(), `xk-brown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bug.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 't', scripts: { test: 'node -e "process.exit(0)"' }
    }));
    projectContext.setRoot(dir);
    const g = await grepProject(dir, 'const x');
    if (!g.hits.length) throw new Error('brownfield grep failed');
    console.log('  brownfield grep: OK');
}

async function greenfield() {
    const dir = path.join(os.tmpdir(), `xk-green-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    await gitIntegration.init(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = () => 42;\n');
    fs.writeFileSync(path.join(dir, 'index.test.js'), 'const assert = require("assert");\nassert.strictEqual(require("./index.js")(), 42);\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'app', version: '1.0.0', scripts: { test: 'node index.test.js' }
    }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# App\n');
    const test = require('../lib/verificationHarness.js');
    const plan = { testCmd: 'npm test', lintCmd: null, verifyPolicy: 'block', steps: [{ id: 1, verifiedAt: null }] };
    const v = await test.runVerification(dir, plan);
    if (!v.ok) throw new Error('greenfield test failed: ' + v.messages);
    console.log('  greenfield scaffold+test: OK');
}

async function undo() {
    const dir = path.join(os.tmpdir(), `xk-undo-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    projectContext.setRoot(dir);
    await gitIntegration.init(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    await gitIntegration.commit(dir, 'v1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
    const ledgerDir = path.join(dir, '.xk-user');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledger = new ChangeLedger(ledgerDir);
    const planStore = new PlanStore(ledgerDir, projectContext);
    const plan = planStore.createEmptyPlan('u', ['s'], dir);
    await planStore.save(plan);
    const editEngine = new EditEngine(ledger, projectContext);
    await editEngine.apply(plan.id, 'a.txt', 'v2', 'v1');
    const rev = await ledger.revertAll(plan.id);
    if (fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8') !== 'v2\n') throw new Error('ledger revert failed');
    console.log('  ledger revert: OK');
}

(async () => {
    await brownfield();
    await greenfield();
    await undo();
    console.log('\nAll ship-check scenarios passed.');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
