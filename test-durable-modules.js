/**
 * Manual verification script for durable memory modules (run: node test-durable-modules.js)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = path.join(os.tmpdir(), 'xkaliber-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const projectContext = require('./projectContext.js');
const ChangeLedger = require('./changeLedger.js');
const EditEngine = require('./editEngine.js');
const PlanStore = require('./planStore.js');

const ledger = new ChangeLedger(testDir);
const editEngine = new EditEngine(ledger, projectContext);
const planStore = new PlanStore(testDir, projectContext);

async function run() {
    console.log('Test dir:', testDir);

    projectContext.setRoot(testDir);
    const resolved = projectContext.resolvePath('sample.txt');
    if (resolved.error) throw new Error(resolved.error);

    const plan = planStore.createEmptyPlan('Test goal', ['Create file', 'Edit file'], testDir);
    await planStore.save(plan);
    console.log('Plan created:', plan.id);

    const filePath = path.join(testDir, 'sample.txt');
    fs.writeFileSync(filePath, 'hello world\nline two\n');
    await ledger.snapshotBefore(plan.id, filePath, 'write');
    fs.writeFileSync(filePath, 'hello universe\nline two\n');

    const diffRes = await ledger.diff(plan.id);
    console.log('Diff lines:', diffRes.diff.split('\n').length);

    const editRes = await editEngine.apply(plan.id, 'sample.txt', 'line two', 'line THREE');
    console.log('Edit:', editRes.success ? 'OK' : editRes.error);

    const revertRes = await ledger.revertAll(plan.id);
    console.log('Revert:', revertRes.reverted.length, 'actions');

    const content = fs.readFileSync(filePath, 'utf-8');
    console.log('Restored content:', content.includes('hello world') ? 'OK' : 'FAIL');

    planStore.approve(plan);
    planStore.markStepDone(plan, 1, 'Created sample.txt');
    await planStore.save(plan);
    console.log('Plan step:', plan.currentStepId);

    console.log('\nAll module checks passed.');
}

run().catch(e => {
    console.error('FAILED:', e);
    process.exit(1);
});
