/**
 * The brain — picks the highest-priority routine that can run and executes it.
 * Operates on a single CharacterContext.
 */
import * as log from './log.mjs';
import { recordRoutineState } from './services/ui-state.mjs';

export class Scheduler {
  constructor(ctx, routines = []) {
    this.ctx = ctx;
    this.routines = [...routines].sort((a, b) => b.priority - a.priority);

    this.stopRequested = false;
    this.runningPromise = null;
    this.sleepTimer = null;
    this.sleepResolver = null;
    this._pendingConfig = null;
  }

  /**
   * Queue a config update to be applied at the next loop iteration.
   * Wakes the scheduler from sleep so it picks up the change promptly.
   */
  setPendingConfig(routineConfigs, settings) {
    this._pendingConfig = { routineConfigs, settings };
    this._interruptSleep();
  }

  _applyPendingConfig() {
    const pending = this._pendingConfig;
    if (!pending) return;
    this._pendingConfig = null;

    const { routineConfigs, settings } = pending;
    if (settings) {
      this.ctx.updateSettings(settings);
    }

    for (const routine of this.routines) {
      if (!routine.configType) continue;
      const match = routineConfigs.find(c => c.type === routine.configType);
      if (match) routine.updateConfig(match);
    }

    log.info(`[${this.ctx.name}] Config hot-reloaded`);
  }

  /** Return the highest-priority routine whose canRun() passes. */
  pickRoutine() {
    for (const routine of this.routines) {
      if (routine.canRun(this.ctx)) return routine;
    }
    return null;
  }

  _finishSleep(completed) {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    const resolve = this.sleepResolver;
    this.sleepResolver = null;
    if (resolve) {
      resolve(completed);
    }
  }

  _interruptSleep() {
    this._finishSleep(false);
  }

  _sleep(ms) {
    if (this.stopRequested) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(() => {
        this._finishSleep(true);
      }, ms);
    });
  }

  async stop() {
    this.stopRequested = true;
    this._interruptSleep();

    if (!this.runningPromise) return;
    try {
      await this.runningPromise;
    } catch {
      // Runtime manager observes loop failures separately.
    }
  }

  async _runLoop() {
    this.stopRequested = false;
    log.info(`[${this.ctx.name}] Bot loop started`);

    // Wait out any active cooldown from a previous session.
    {
      await this.ctx.refresh();
      if (this.stopRequested) return;
      const remainingMs = this.ctx.cooldownRemainingMs();
      if (remainingMs > 500) {
        log.info(`[${this.ctx.name}] On cooldown — waiting ${(remainingMs / 1000).toFixed(1)}s`);
        const slept = await this._sleep(remainingMs);
        if (!slept) return;
      }
    }

    while (!this.stopRequested) {
      this._applyPendingConfig();

      await this.ctx.refresh();
      if (this.stopRequested) break;

      const routine = this.pickRoutine();

      if (!routine) {
        recordRoutineState(this.ctx.name, {
          routineName: null,
          phase: 'idle',
          priority: null,
        });
        log.warn(`[${this.ctx.name}] No runnable routines - idling 30s`);
        const slept = await this._sleep(30_000);
        if (!slept) break;
        continue;
      }

      recordRoutineState(this.ctx.name, {
        routineName: routine.name,
        phase: 'start',
        priority: routine.priority,
      });
      log.info(`[${this.ctx.name}] -> ${routine.name}`);

      try {
        if (routine.loop) {
          let keepGoing = true;
          while (keepGoing && !this.stopRequested) {
            await this.ctx.refresh();
            if (this.stopRequested) break;

            if (!routine.canRun(this.ctx)) {
              log.info(`[${this.ctx.name}] ${routine.name}: conditions changed, yielding`);
              break;
            }

            // Preemption: yield if a higher-priority routine needs to run.
            const preempt = this.routines.find(
              r => r.priority > routine.priority && r.canRun(this.ctx),
            );
            if (preempt && routine.canBePreempted(this.ctx)) {
              log.info(`[${this.ctx.name}] ${routine.name}: preempted by ${preempt.name}`);
              break;
            }

            keepGoing = await routine.execute(this.ctx);
          }
        } else if (!this.stopRequested) {
          await routine.execute(this.ctx);
        }

        if (!this.stopRequested) {
          recordRoutineState(this.ctx.name, {
            routineName: routine.name,
            phase: 'done',
            priority: routine.priority,
          });
          log.info(`[${this.ctx.name}] ${routine.name}: done`);
        }
      } catch (err) {
        if (this.stopRequested) break;

        recordRoutineState(this.ctx.name, {
          routineName: routine.name,
          phase: 'error',
          priority: routine.priority,
          error: err.message,
        });
        log.error(`[${this.ctx.name}] ${routine.name} failed`, err.message);

        const slept = await this._sleep(10_000);
        if (!slept) break;
      }

      const slept = await this._sleep(1_000);
      if (!slept) break;
    }

    recordRoutineState(this.ctx.name, {
      routineName: null,
      phase: 'idle',
      priority: null,
    });
    log.info(`[${this.ctx.name}] Bot loop stopped`);
  }

  /** Main loop - runs until stop() is called. */
  async run() {
    if (this.runningPromise) {
      return this.runningPromise;
    }

    this.runningPromise = this._runLoop().finally(() => {
      this._finishSleep(false);
      this.runningPromise = null;
    });

    return this.runningPromise;
  }
}
