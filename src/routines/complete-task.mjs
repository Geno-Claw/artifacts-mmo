/**
 * Complete Task Routine — hands in completed NPC/item tasks opportunistically.
 *
 * Fires at priority 45 (between bank deposit and skill rotation) whenever
 * ctx.taskComplete() is true. Moves to the correct task master and completes
 * the task. Does NOT exchange task coins (that stays in SkillRotation).
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo } from '../helpers.mjs';
import { TASKS_MASTER } from '../data/locations.mjs';
import { inferTaskType } from './skill-rotation/npc-tasks.mjs';

const TAG = 'CompleteTask';

export class CompleteTaskRoutine extends BaseRoutine {
  constructor({ priority = 45, ...rest } = {}) {
    super({ name: TAG, priority, loop: false, ...rest });
  }

  canRun(ctx) {
    return ctx.taskComplete();
  }

  async execute(ctx) {
    const c = ctx.get();
    const taskCode = c.task;

    // Determine task type: use API field first, fall back to game data inference
    let taskType = c.task_type;
    if (taskType !== 'monsters' && taskType !== 'items') {
      taskType = inferTaskType(taskCode);
    }

    if (!taskType) {
      log.warn(`[${ctx.name}] ${TAG}: cannot determine task type for "${taskCode}", skipping`);
      return;
    }

    const master = TASKS_MASTER[taskType];

    log.info(`[${ctx.name}] ${TAG}: handing in completed ${taskType} task "${taskCode}" (${c.task_progress}/${c.task_total})`);

    await moveTo(ctx, master.x, master.y);
    const result = await api.completeTask(ctx.name);
    ctx.applyActionResult(result);
    await api.waitForCooldown(result);

    log.info(`[${ctx.name}] ${TAG}: task "${taskCode}" handed in`);
  }
}
