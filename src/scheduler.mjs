/**
 * The brain — picks the highest-priority routine that can run and executes it.
 * Operates on a single CharacterContext.
 */
import * as log from './log.mjs';
import { recordRoutineState } from './services/ui-state.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Scheduler {
  constructor(ctx, routines = []) {
    this.ctx = ctx;
    this.routines = [...routines].sort((a, b) => b.priority - a.priority);
  }

  /** Return the highest-priority routine whose canRun() passes. */
  pickRoutine() {
    for (const routine of this.routines) {
      if (routine.canRun(this.ctx)) return routine;
    }
    return null;
  }

  /** Main loop — runs forever. */
  async run() {
    log.info(`[${this.ctx.name}] Bot loop started`);

    while (true) {
      await this.ctx.refresh();
      const routine = this.pickRoutine();

      if (!routine) {
        recordRoutineState(this.ctx.name, {
          routineName: null,
          phase: 'idle',
          priority: null,
        });
        log.warn(`[${this.ctx.name}] No runnable routines — idling 30s`);
        await sleep(30_000);
        continue;
      }

      recordRoutineState(this.ctx.name, {
        routineName: routine.name,
        phase: 'start',
        priority: routine.priority,
      });
      log.info(`[${this.ctx.name}] → ${routine.name}`);

      try {
        if (routine.loop) {
          let keepGoing = true;
          while (keepGoing) {
            await this.ctx.refresh();
            if (!routine.canRun(this.ctx)) {
              log.info(`[${this.ctx.name}] ${routine.name}: conditions changed, yielding`);
              break;
            }
            // Preemption: yield if a higher-priority routine needs to run
            const preempt = this.routines.find(r => r.priority > routine.priority && r.canRun(this.ctx));
            if (preempt && routine.canBePreempted(this.ctx)) {
              log.info(`[${this.ctx.name}] ${routine.name}: preempted by ${preempt.name}`);
              break;
            }
            keepGoing = await routine.execute(this.ctx);
          }
        } else {
          await routine.execute(this.ctx);
        }
        recordRoutineState(this.ctx.name, {
          routineName: routine.name,
          phase: 'done',
          priority: routine.priority,
        });
        log.info(`[${this.ctx.name}] ${routine.name}: done`);
      } catch (err) {
        recordRoutineState(this.ctx.name, {
          routineName: routine.name,
          phase: 'error',
          priority: routine.priority,
          error: err.message,
        });
        log.error(`[${this.ctx.name}] ${routine.name} failed`, err.message);
        await sleep(10_000);
      }

      await sleep(1_000);
    }
  }
}
