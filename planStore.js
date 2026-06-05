const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

class PlanStore {
    constructor(userDataPath, projectContext) {
        this.plansDir = path.join(userDataPath, 'plans');
        this.projectContext = projectContext;
    }

    async ensureDir() {
        await fsPromises.mkdir(this.plansDir, { recursive: true });
    }

    planPath(planId) {
        return path.join(this.plansDir, `${planId}.json`);
    }

    generateId() {
        return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    createEmptyPlan(goal, steps, userText) {
        const id = this.generateId();
        const existingRoot = this.projectContext.getRootOrNull();
        const parsedRoot = this.projectContext.parsePathFromText(userText || goal);

        if (parsedRoot && !existingRoot) {
            // No explicit workspace — infer the repo root (walk up for pyproject.toml etc.)
            this.projectContext.setRoot(this.projectContext.resolveBestProjectRoot(parsedRoot));
        }
        // When the user picked a workspace via "Here I am", never override it from prompt text.

        const plan = {
            id,
            projectRoot: this.projectContext.getRootOrNull(),
            goal,
            status: 'awaiting_approval',
            createdAt: Date.now(),
            projectType: 'brownfield',
            testCmd: null,
            lintCmd: null,
            installCmd: null,
            verifyPolicy: 'block',
            plannerModel: null,
            editorModel: null,
            activeFiles: [],
            readOnlyFiles: [],
            steps: (steps || []).map((title, i) => ({
                id: i + 1,
                title: typeof title === 'string' ? title : title.title || String(title),
                status: 'pending',
                result: '',
                filesTouched: [],
                verifiedAt: null
            })),
            currentStepId: null,
            filesLedger: {},
            decisions: [],
            scratchpad: ''
        };
        return plan;
    }

    async save(plan) {
        await this.ensureDir();
        if (plan.projectRoot) {
            this.projectContext.setRoot(plan.projectRoot);
        }
        this.projectContext.setPlanId(plan.id);
        await fsPromises.writeFile(this.planPath(plan.id), JSON.stringify(plan, null, 2), 'utf-8');
        return { success: true };
    }

    async load(planId) {
        try {
            const raw = await fsPromises.readFile(this.planPath(planId), 'utf-8');
            const plan = JSON.parse(raw);
            if (plan.projectRoot) {
                this.projectContext.setRoot(plan.projectRoot);
            }
            this.projectContext.setPlanId(plan.id);
            return plan;
        } catch (e) {
            return { error: e.message };
        }
    }

    async listActive() {
        await this.ensureDir();
        const files = await fsPromises.readdir(this.plansDir);
        const active = [];
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try {
                const raw = await fsPromises.readFile(path.join(this.plansDir, f), 'utf-8');
                const plan = JSON.parse(raw);
                if (['awaiting_approval', 'executing'].includes(plan.status)) {
                    active.push({ id: plan.id, goal: plan.goal, status: plan.status, currentStepId: plan.currentStepId });
                }
            } catch (e) { /* skip */ }
        }
        return active;
    }

    getCurrentStep(plan) {
        if (!plan || !plan.steps) return null;
        const id = plan.currentStepId || plan.steps.find(s => s.status === 'pending' || s.status === 'active')?.id;
        return plan.steps.find(s => s.id === id) || null;
    }

    approve(plan) {
        plan.status = 'executing';
        const first = plan.steps.find(s => s.status === 'pending' || s.status === 'active');
        if (first) {
            first.status = 'active';
            plan.currentStepId = first.id;
        }
        return plan;
    }

    markStepDone(plan, stepId, result, opts = {}) {
        const step = plan.steps.find(s => s.id === stepId);
        if (step) {
            if (plan.verifyPolicy !== 'off' && !step.verifiedAt && !opts.force) {
                return { error: 'Step not verified. Run verification or run_verify first.', plan };
            }
            step.status = 'done';
            step.result = result || 'Completed';
        }
        const next = plan.steps.find(s => s.status === 'pending');
        if (next) {
            next.status = 'active';
            plan.currentStepId = next.id;
        } else {
            plan.currentStepId = null;
            plan.status = 'done';
        }
        return plan;
    }

    markStepBlocked(plan, stepId, reason) {
        const step = plan.steps.find(s => s.id === stepId);
        if (step) {
            step.status = 'failed';
            step.result = reason || 'Blocked';
        }
        plan.scratchpad = (plan.scratchpad || '') + `\n[BLOCKED step ${stepId}]: ${reason}`;
        const next = plan.steps.find(s => s.status === 'pending');
        if (next) {
            next.status = 'active';
            plan.currentStepId = next.id;
            plan.status = 'executing';
        } else {
            plan.currentStepId = null;
            plan.status = plan.steps.some(s => s.status === 'failed') ? 'failed' : 'done';
        }
        return plan;
    }

    // Append new pending steps to a running plan (the agent discovered work mid-build).
    // Returns the added step objects. Ids continue from the current max so they stay unique.
    addSteps(plan, titles) {
        const list = Array.isArray(titles) ? titles : [titles];
        const maxId = plan.steps.reduce((m, s) => Math.max(m, s.id || 0), 0);
        const added = [];
        list.forEach((t) => {
            const title = typeof t === 'string' ? t : (t && t.title) || String(t);
            if (!title.trim()) return;
            const step = {
                // Use added.length (not the source index) so skipped empty titles
                // don't leave gaps in the id sequence.
                id: maxId + 1 + added.length,
                title: title.trim(),
                status: 'pending',
                result: '',
                filesTouched: [],
                verifiedAt: null,
                blockAttempts: 0
            };
            plan.steps.push(step);
            added.push(step);
        });
        // If the plan had run out of pending steps and was about to finish, re-activate.
        if (!plan.currentStepId && added.length) {
            plan.currentStepId = added[0].id;
            added[0].status = 'active';
            if (plan.status === 'done') plan.status = 'executing';
        }
        return added;
    }

    applyDetector(plan, detector) {
        if (!detector) return plan;
        if (detector.projectType) plan.projectType = detector.projectType;
        if (detector.testCmd) plan.testCmd = detector.testCmd;
        if (detector.lintCmd) plan.lintCmd = detector.lintCmd;
        if (detector.installCmd) plan.installCmd = detector.installCmd;
        return plan;
    }

    recordFileTouch(plan, relPath, action) {
        if (!plan.filesLedger[relPath]) {
            plan.filesLedger[relPath] = { created: action === 'create', lastAction: action };
        } else {
            plan.filesLedger[relPath].lastAction = action;
        }
        const step = this.getCurrentStep(plan);
        if (step && !step.filesTouched.includes(relPath)) {
            step.filesTouched.push(relPath);
        }
    }

    addDecision(plan, text) {
        if (text && !plan.decisions.includes(text)) {
            plan.decisions.push(text);
        }
    }

    appendScratchpad(plan, text) {
        plan.scratchpad = (plan.scratchpad || '') + '\n' + text;
    }
}

module.exports = PlanStore;
