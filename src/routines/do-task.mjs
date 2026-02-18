import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo } from '../helpers.mjs';
import { TASKS_MASTER } from '../data/locations.mjs';

export class CompleteNpcTaskRoutine extends BaseRoutine {
  constructor({ priority = 60 } = {}) {
    super({ name: 'Complete NPC Task', priority, loop: false });
  }

  canRun(ctx) {
    if (!ctx.taskComplete()) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    const c = ctx.get();
    log.info(`[${ctx.name}] Completing task: ${c.task} (${c.task_progress}/${c.task_total})`);
    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.completeTask(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
  }
}

export class AcceptNpcTaskRoutine extends BaseRoutine {
  constructor({ priority = 15 } = {}) {
    super({ name: 'Accept NPC Task', priority, loop: false });
  }

  canRun(ctx) {
    if (ctx.hasTask()) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    log.info(`[${ctx.name}] Accepting new task`);
    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.acceptTask(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    const c = ctx.get();
    log.info(`[${ctx.name}] New task: ${c.task} (0/${c.task_total})`);
  }
}
