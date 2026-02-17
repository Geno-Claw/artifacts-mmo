/**
 * The brain — picks the highest-priority task that can run and executes it.
 * Operates on a single CharacterContext.
 */
import * as log from './log.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Scheduler {
  constructor(ctx, tasks = []) {
    this.ctx = ctx;
    this.tasks = [...tasks].sort((a, b) => b.priority - a.priority);
  }

  /** Return the highest-priority task whose canRun() passes. */
  pickTask() {
    for (const task of this.tasks) {
      if (task.canRun(this.ctx)) return task;
    }
    return null;
  }

  /** Main loop — runs forever. */
  async run() {
    log.info(`[${this.ctx.name}] Bot loop started`);

    while (true) {
      await this.ctx.refresh();
      const task = this.pickTask();

      if (!task) {
        log.warn(`[${this.ctx.name}] No runnable tasks — idling 30s`);
        await sleep(30_000);
        continue;
      }

      log.info(`[${this.ctx.name}] → ${task.name}`);

      try {
        if (task.loop) {
          let keepGoing = true;
          while (keepGoing) {
            await this.ctx.refresh();
            if (!task.canRun(this.ctx)) {
              log.info(`[${this.ctx.name}] ${task.name}: conditions changed, yielding`);
              break;
            }
            keepGoing = await task.execute(this.ctx);
          }
        } else {
          await task.execute(this.ctx);
        }
        log.info(`[${this.ctx.name}] ${task.name}: done`);
      } catch (err) {
        log.error(`[${this.ctx.name}] ${task.name} failed`, err.message);
        await sleep(10_000);
      }

      await sleep(1_000);
    }
  }
}
