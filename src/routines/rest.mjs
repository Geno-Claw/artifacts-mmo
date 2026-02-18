import { BaseRoutine } from './base.mjs';
import { canUseRestAction, hasHealingFood, restUntil } from '../helpers.mjs';

export class RestRoutine extends BaseRoutine {
  constructor({ triggerPct = 40, targetPct = 80, priority = 100 } = {}) {
    super({ name: 'Rest', priority, loop: false });
    this.triggerPct = triggerPct;
    this.targetPct = targetPct;
  }

  canRun(ctx) {
    if (ctx.hpPercent() >= this.triggerPct) return false;
    return canUseRestAction(ctx) || hasHealingFood(ctx);
  }

  async execute(ctx) {
    await restUntil(ctx, this.targetPct);
  }
}
