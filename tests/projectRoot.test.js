const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectContext = require('../projectContext.js');
const PlanStore = require('../planStore.js');

function makeNanobotLayout() {
    const root = path.join(os.tmpdir(), `xk-nanobot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const pkg = path.join(root, 'nanobot');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "nanobot"\n');
    fs.writeFileSync(path.join(pkg, '__init__.py'), '__version__ = "0.1.0"\n');
    return { root, pkg };
}

test('resolveBestProjectRoot: walks up from package subfolder to pyproject.toml', () => {
    const { root, pkg } = makeNanobotLayout();
    const resolved = projectContext.resolveBestProjectRoot(pkg);
    assert.equal(path.resolve(resolved), path.resolve(root));
});

test('parsePathFromText: handles Windows paths with spaces', () => {
    const { root, pkg } = makeNanobotLayout();
    const parsed = projectContext.parsePathFromText(`Build at ${pkg} please`);
    assert.equal(path.resolve(parsed), path.resolve(pkg));
});

test('createEmptyPlan: keeps Here-I-am workspace when prompt mentions a subfolder', () => {
    const { root, pkg } = makeNanobotLayout();
    const storeDir = path.join(os.tmpdir(), `xk-store-${Date.now()}`);
    fs.mkdirSync(storeDir, { recursive: true });
    const planStore = new PlanStore(storeDir, projectContext);

    projectContext.clear();
    projectContext.setRoot(root);
    const userText = `Finish nanobot. Workspace is ${pkg}`;
    const plan = planStore.createEmptyPlan('Build nanobot', ['Inspect structure'], userText);

    assert.equal(path.resolve(plan.projectRoot), path.resolve(root));
    assert.equal(path.resolve(projectContext.getRootOrNull()), path.resolve(root));
    projectContext.clear();
});

test('createEmptyPlan: without workspace, infers repo root from subfolder in prompt', () => {
    const { root, pkg } = makeNanobotLayout();
    const storeDir = path.join(os.tmpdir(), `xk-store2-${Date.now()}`);
    fs.mkdirSync(storeDir, { recursive: true });
    const planStore = new PlanStore(storeDir, projectContext);

    projectContext.clear();
    const plan = planStore.createEmptyPlan('Build nanobot', ['Inspect'], `Project at ${pkg}`);

    assert.equal(path.resolve(plan.projectRoot), path.resolve(root));
    projectContext.clear();
});

test('isSubdirectoryOf detects package folder inside repo', () => {
    const { root, pkg } = makeNanobotLayout();
    assert.ok(projectContext.isSubdirectoryOf(pkg, root));
    assert.ok(!projectContext.isSubdirectoryOf(root, pkg));
});
