import { BaseRoutine } from './base.mjs';
import { canUseRestAction, hasHealingFood, restUntil } from '../services/food-manager.mjs';

export class RestRoutine extends BaseRoutine {
  constructor({ triggerPct = 40, targetPct = 80, priority = 100, ...rest } = {}) {
    super({ name: 'Rest', priority, loop: false, ...rest });
    this.triggerPct = triggerPct;
    this.targetPct = targetPct;
  }

  updateConfig({ triggerPct, targetPct } = {}) {
    if (triggerPct !== undefined) this.triggerPct = triggerPct;
    if (targetPct !== undefined) this.targetPct = targetPct;
  }

  canRun(ctx) {
    if (ctx.hpPercent() >= this.triggerPct) return false;
    return canUseRestAction(ctx) || hasHealingFood(ctx);
  }

  async execute(ctx) {
    await restUntil(ctx, this.targetPct);
  }
}
