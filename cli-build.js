#!/usr/bin/env node
/**
 * Headless build entry: node cli-build.js "goal text" [projectRoot]
 * Uses same engines as Electron main process (no UI).
 */
const path = require('path');
const os = require('os');

const userData = path.join(os.homedir(), '.config', 'xkaliber-agent');
const projectContext = require('./projectContext.js');
const ChangeLedger = require('./changeLedger.js');
const EditEngine = require('./editEngine.js');
const PlanStore = require('./planStore.js');
const projectDetector = require('./lib/projectDetector.js');
const { stepsForType } = require('./lib/planTemplates.js');

const goal = process.argv[2];
const rootArg = process.argv[3];

if (!goal) {
    console.error('Usage: node cli-build.js "<goal>" [projectRoot]');
    process.exit(1);
}

const root = rootArg ? path.resolve(rootArg) : process.cwd();
projectContext.setRoot(root);

const ledger = new ChangeLedger(userData);
const planStore = new PlanStore(userData, projectContext);
const editEngine = new EditEngine(ledger, projectContext);

async function main() {
    const det = projectDetector.detect(root);
    const steps = stepsForType(det.projectType === 'greenfield' ? 'greenfield' : 'brownfield', det.language);
    const plan = planStore.createEmptyPlan(goal, steps, root);
    planStore.applyDetector(plan, det);
    plan.projectRoot = root;
    planStore.approve(plan);
    await planStore.save(plan);
    console.log(JSON.stringify({ planId: plan.id, goal: plan.goal, steps: plan.steps.length, testCmd: plan.testCmd }, null, 2));
    console.error('Plan created and approved. Full execution requires Electron UI or LM Studio API integration in cli-build.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
