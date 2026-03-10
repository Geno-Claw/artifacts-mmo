/**
 * The brain — picks the highest-priority routine that can run and executes it.
 * Operates on a single CharacterContext.
 */
import * as log from './log.mjs';
import { recordRoutineState } from './services/ui-state.mjs';
import { runWithLogContext } from './log-context.mjs';

const schedulerLog = log.createLogger({ scope: 'scheduler' });

export class Scheduler {
  constructor(ctx, routines = []) {
    this.ctx = ctx;
    this.routines = [...routines].sort((a, b) => b.priority - a.priority);
    for (const r of this.routines) {
      r._peerRoutines = this.routines;
    }

    this.stopRequested = false;
    this.runningPromise = null;
    this.sleepTimer = null;
    this.sleepResolver = null;
    this._pendingConfig = null;
    this.runId = null;
    this.tickSeq = 0;
  }

  setRunContext({ runId = null } = {}) {
    const parsed = Number(runId);
    this.runId = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
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

    schedulerLog.info(`[${this.ctx.name}] Config hot-reloaded`, {
      event: 'scheduler.config.hot_reloaded',
      context: {
        character: this.ctx.name,
        runId: this.runId,
        tickId: this.tickSeq,
      },
    });
  }

  _routinePriority(routine) {
    return Number(routine.effectivePriority?.(this.ctx) ?? routine.priority) || 0;
  }

  _routineUrgent(routine) {
    return routine.isUrgent?.(this.ctx) === true;
  }

  /** Return the highest-priority routine whose canRun() passes + debug candidates. */
  pickRoutineWithDetails() {
    let selected = null;
    let selectedPriority = Number.NEGATIVE_INFINITY;
    let selectedUrgent = false;
    const candidates = [];

    for (const routine of this.routines) {
      const priority = this._routinePriority(routine);
      const urgent = this._routineUrgent(routine);
      let runnable = false;
      try {
        runnable = routine.canRun(this.ctx) === true;
      } catch (err) {
        schedulerLog.error(`[${this.ctx.name}] canRun failed for ${routine.name}`, {
          event: 'scheduler.routine.can_run_error',
          reasonCode: 'routine_can_run_error',
          context: {
            character: this.ctx.name,
            runId: this.runId,
            routine: routine.name,
          },
          error: err,
        });
        throw err;
      }
      candidates.push({
        name: routine.name,
        priority,
        urgent,
        runnable,
      });
      if (runnable && (
        !selected
        || priority > selectedPriority
        || (priority === selectedPriority && urgent && !selectedUrgent)
      )) {
        selected = routine;
        selectedPriority = priority;
        selectedUrgent = urgent;
      }
    }

    return {
      routine: selected,
      candidates,
      priority: selected ? selectedPriority : null,
      urgent: selected ? selectedUrgent : null,
    };
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
    schedulerLog.info(`[${this.ctx.name}] Bot loop started`, {
      event: 'scheduler.loop.started',
      context: {
        character: this.ctx.name,
        runId: this.runId,
      },
    });

    // Wait out any active cooldown from a previous session.
    {
      await runWithLogContext({
        character: this.ctx.name,
        runId: this.runId,
        tickId: this.tickSeq,
      }, async () => this.ctx.refresh());
      if (this.stopRequested) return;
      const remainingMs = this.ctx.cooldownRemainingMs();
      if (remainingMs > 500) {
        schedulerLog.info(`[${this.ctx.name}] On cooldown — waiting ${(remainingMs / 1000).toFixed(1)}s`, {
          event: 'scheduler.cooldown_wait',
          context: {
            character: this.ctx.name,
            runId: this.runId,
            tickId: this.tickSeq,
          },
          data: {
            remainingMs,
          },
        });
        const slept = await this._sleep(remainingMs);
        if (!slept) return;
      }
    }

    while (!this.stopRequested) {
      const tickId = ++this.tickSeq;
      schedulerLog.debug(`[${this.ctx.name}] Tick ${tickId} start`, {
        event: 'scheduler.tick.start',
        context: {
          character: this.ctx.name,
          runId: this.runId,
          tickId,
        },
      });

      this._applyPendingConfig();

      await runWithLogContext({
        character: this.ctx.name,
        runId: this.runId,
        tickId,
      }, async () => this.ctx.refresh());
      if (this.stopRequested) break;

      const { routine, candidates, priority: selectedPriority, urgent: selectedUrgent } = this.pickRoutineWithDetails();
      schedulerLog.debug(`[${this.ctx.name}] Tick ${tickId} routine scan`, {
        event: 'scheduler.routines.scanned',
        context: {
          character: this.ctx.name,
          runId: this.runId,
          tickId,
        },
        data: {
          selected: routine?.name || null,
          candidates,
        },
      });

      if (!routine) {
        recordRoutineState(this.ctx.name, {
          routineName: null,
          phase: 'idle',
          priority: null,
        });
        schedulerLog.warn(`[${this.ctx.name}] No runnable routines - idling 30s`, {
          event: 'scheduler.idle',
          reasonCode: 'no_runnable_routine',
          context: {
            character: this.ctx.name,
            runId: this.runId,
            tickId,
          },
        });
        const slept = await this._sleep(30_000);
        if (!slept) break;
        continue;
      }

      recordRoutineState(this.ctx.name, {
        routineName: routine.name,
        phase: 'start',
        priority: selectedPriority,
      });
      schedulerLog.info(`[${this.ctx.name}] -> ${routine.name}`, {
        event: 'routine.started',
        context: {
          character: this.ctx.name,
          runId: this.runId,
          tickId,
          routine: routine.name,
        },
        data: {
          priority: selectedPriority,
          loop: routine.loop === true,
          urgent: selectedUrgent === true,
        },
      });

      try {
        if (routine.loop) {
          let keepGoing = true;
          while (keepGoing && !this.stopRequested) {
            await runWithLogContext({
              character: this.ctx.name,
              runId: this.runId,
              tickId,
              routine: routine.name,
            }, async () => this.ctx.refresh());
            if (this.stopRequested) break;

            if (!routine.canRun(this.ctx)) {
              schedulerLog.info(`[${this.ctx.name}] ${routine.name}: conditions changed, yielding`, {
                event: 'routine.yield',
                reasonCode: 'routine_conditions_changed',
                context: {
                  character: this.ctx.name,
                  runId: this.runId,
                  tickId,
                  routine: routine.name,
                },
              });
              break;
            }

            // Preemption: yield if a higher-priority routine needs to run.
            const currentPriority = this._routinePriority(routine);
            const canBePreempted = routine.canBePreempted(this.ctx) === true;
            let preempt = null;
            let preemptPriority = Number.NEGATIVE_INFINITY;
            let preemptUrgent = false;
            for (const candidate of this.routines) {
              if (candidate === routine) continue;
              const candidatePriority = this._routinePriority(candidate);
              if (candidatePriority <= currentPriority) continue;
              if (!candidate.canRun(this.ctx)) continue;
              const candidateUrgent = this._routineUrgent(candidate);
              if (
                !preempt
                || candidatePriority > preemptPriority
                || (candidatePriority === preemptPriority && candidateUrgent && !preemptUrgent)
              ) {
                preempt = candidate;
                preemptPriority = candidatePriority;
                preemptUrgent = candidateUrgent;
              }
            }
            if (preempt && (preemptUrgent || canBePreempted)) {
              schedulerLog.info(`[${this.ctx.name}] ${routine.name}: preempted by ${preempt.name}`, {
                event: 'routine.preempted',
                reasonCode: 'preempted_by_higher_priority',
                context: {
                  character: this.ctx.name,
                  runId: this.runId,
                  tickId,
                  routine: routine.name,
                },
                data: {
                  interruptedRoutine: routine.name,
                  interruptingRoutine: preempt.name,
                  interruptingPriority: preemptPriority,
                  interruptingUrgent: preemptUrgent,
                  canBePreempted,
                },
              });
              break;
            }

            keepGoing = await runWithLogContext({
              character: this.ctx.name,
              runId: this.runId,
              tickId,
              routine: routine.name,
            }, async () => routine.execute(this.ctx));
            if (!keepGoing) {
              const yieldReason = routine.consumeYieldReason?.();
              if (yieldReason) {
                schedulerLog.info(`[${this.ctx.name}] ${routine.name}: yielding (${yieldReason.reasonCode})`, {
                  event: 'routine.yield',
                  reasonCode: yieldReason.reasonCode,
                  context: {
                    character: this.ctx.name,
                    runId: this.runId,
                    tickId,
                    routine: routine.name,
                  },
                  data: yieldReason.data,
                });
              }
            }
          }
        } else if (!this.stopRequested) {
          await runWithLogContext({
            character: this.ctx.name,
            runId: this.runId,
            tickId,
            routine: routine.name,
          }, async () => routine.execute(this.ctx));
        }

        if (!this.stopRequested) {
          recordRoutineState(this.ctx.name, {
            routineName: routine.name,
            phase: 'done',
            priority: selectedPriority,
          });
          schedulerLog.info(`[${this.ctx.name}] ${routine.name}: done`, {
            event: 'routine.done',
            context: {
              character: this.ctx.name,
              runId: this.runId,
              tickId,
              routine: routine.name,
            },
          });
        }
      } catch (err) {
        if (this.stopRequested) break;

        recordRoutineState(this.ctx.name, {
          routineName: routine.name,
          phase: 'error',
          priority: selectedPriority,
          error: err.message,
        });
        schedulerLog.error(`[${this.ctx.name}] ${routine.name} failed`, {
          event: 'routine.error',
          reasonCode: 'routine_execution_failed',
          context: {
            character: this.ctx.name,
            runId: this.runId,
            tickId,
            routine: routine.name,
          },
          error: err,
          detail: err?.message || String(err),
        });

        const slept = await this._sleep(10_000);
        if (!slept) break;
      }

      const slept = await this._sleep(1_000);
      if (!slept) break;

      schedulerLog.debug(`[${this.ctx.name}] Tick ${tickId} end`, {
        event: 'scheduler.tick.end',
        context: {
          character: this.ctx.name,
          runId: this.runId,
          tickId,
        },
      });
    }

    recordRoutineState(this.ctx.name, {
      routineName: null,
      phase: 'idle',
      priority: null,
    });
    schedulerLog.info(`[${this.ctx.name}] Bot loop stopped`, {
      event: 'scheduler.loop.stopped',
      context: {
        character: this.ctx.name,
        runId: this.runId,
        tickId: this.tickSeq,
      },
      reasonCode: this.stopRequested ? 'loop_stop_requested' : null,
    });
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
