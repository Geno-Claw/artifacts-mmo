import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo } from '../helpers.mjs';
import { TASKS_MASTER } from '../data/locations.mjs';

/**
 * Cancels an NPC task that's too hard (too many consecutive losses).
 * Costs 1 task coin. Optional — only add to config if cancel behavior is desired.
 * Without this task, the bot simply falls back to grinding until a level-up
 * resets the loss counter and it retries.
 */
export class CancelNpcTask extends BaseTask {
  constructor({ maxLosses = 2, priority = 55 } = {}) {
    super({ name: 'Cancel NPC Task', priority, loop: false });
    this.maxLosses = maxLosses;
  }

  canRun(ctx) {
    if (!ctx.hasTask()) return false;
    if (ctx.taskComplete()) return false;
    const monster = ctx.get().task;
    if (ctx.consecutiveLosses(monster) < this.maxLosses) return false;
    if (ctx.taskCoins() < 1) return false;
    return true;
  }

  async execute(ctx) {
    const monster = ctx.get().task;
    log.warn(`[${ctx.name}] Cancelling too-hard task: ${monster} (${ctx.consecutiveLosses(monster)} losses)`);

    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.cancelTask(ctx.name);
    await api.waitForCooldown(result);

    ctx.clearLosses(monster);
    await ctx.refresh();

    log.info(`[${ctx.name}] Task cancelled, ready for a new one`);
  }
}
