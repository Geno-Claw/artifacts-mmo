import { BaseTask } from './base.mjs';
import { restUntil } from '../helpers.mjs';

export class RestTask extends BaseTask {
  constructor({ triggerPct = 40, targetPct = 80, priority = 100 } = {}) {
    super({ name: 'Rest', priority, loop: false });
    this.triggerPct = triggerPct;
    this.targetPct = targetPct;
  }

  canRun(ctx) {
    return ctx.hpPercent() < this.triggerPct;
  }

  async execute(ctx) {
    await restUntil(ctx, this.targetPct);
  }
}
