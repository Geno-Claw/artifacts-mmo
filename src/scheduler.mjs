/**
 * The brain — picks the highest-priority task that can run and executes it.
 */
import * as state from './state.mjs';
import * as log from './log.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Scheduler {
  constructor(tasks = []) {
    this.tasks = [...tasks].sort((a, b) => b.priority - a.priority);
  }

  /** Return the highest-priority task whose canRun() passes. */
  pickTask(char) {
    for (const task of this.tasks) {
      if (task.canRun(char)) return task;
    }
    return null;
  }

  /** Main loop — runs forever. */
  async run() {
    log.info('Bot loop started');

    while (true) {
      const char = await state.refresh();
      const task = this.pickTask(char);

      if (!task) {
        log.warn('No runnable tasks — idling 30s');
        await sleep(30_000);
        continue;
      }

      log.info(`→ ${task.name}`);

      try {
        if (task.loop) {
          let keepGoing = true;
          while (keepGoing) {
            const fresh = await state.refresh();
            if (!task.canRun(fresh)) {
              log.info(`${task.name}: conditions changed, yielding`);
              break;
            }
            keepGoing = await task.execute(fresh);
          }
        } else {
          await task.execute(char);
        }
        log.info(`${task.name}: done`);
      } catch (err) {
        log.error(`${task.name} failed`, err.message);
        await sleep(10_000);
      }

      await sleep(1_000);
    }
  }
}
