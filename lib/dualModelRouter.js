/**
 * Select planner vs editor model for a build phase.
 * ctx.plannerModel / ctx.editorModel come from UI; fall back to ctx.model.
 */
function modelForPhase(ctx, phase) {
    if (phase === 'planning') {
        return ctx.plannerModel || ctx.model;
    }
    if (phase === 'execution' || phase === 'review') {
        return ctx.editorModel || ctx.model;
    }
    return ctx.model;
}

function isPlanningPhase(plan) {
    return plan && plan.status === 'awaiting_approval';
}

module.exports = { modelForPhase, isPlanningPhase };
