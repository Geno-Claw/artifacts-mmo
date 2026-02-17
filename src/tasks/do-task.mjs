import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo } from '../helpers.mjs';
import { TASKS_MASTER } from '../data/locations.mjs';

export class CompleteNpcTask extends BaseTask {
  constructor() {
    super({ name: 'Complete NPC Task', priority: 60, loop: false });
  }

  canRun(_char) {
    return state.taskComplete();
  }

  async execute(_char) {
    const c = state.get();
    log.info(`Completing task: ${c.task} (${c.task_progress}/${c.task_total})`);
    await moveTo(TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.completeTask();
    await api.waitForCooldown(result);
    await state.refresh();
  }
}

export class AcceptNpcTask extends BaseTask {
  constructor() {
    super({ name: 'Accept NPC Task', priority: 15, loop: false });
  }

  canRun(_char) {
    return !state.hasTask();
  }

  async execute(_char) {
    log.info('Accepting new task');
    await moveTo(TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.acceptTask();
    await api.waitForCooldown(result);
    await state.refresh();
    const c = state.get();
    log.info(`New task: ${c.task} (0/${c.task_total})`);
  }
}
