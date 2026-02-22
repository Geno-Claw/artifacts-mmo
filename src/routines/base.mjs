/**
 * Base class for all bot routines.
 *
 * Subclasses implement:
 *   canRun(char)  → boolean — prerequisites check
 *   execute(char) → boolean — for loop routines: true=continue, false=stop
 */
export class BaseRoutine {
  constructor({ name, type, priority = 0, loop = false, urgent = false }) {
    this.name = name;
    this.configType = type || null;
    this.priority = priority;
    this.loop = loop;
    this.urgent = urgent;
  }

  /** Hot-reload: patch config fields in-place, preserving runtime state. */
  updateConfig(_cfg) {
    // Subclasses override to accept new config values.
  }

  canRun(_char) {
    throw new Error(`${this.name}: canRun() not implemented`);
  }

  canBePreempted(_ctx) {
    return true;
  }

  /** Check if an urgent higher-priority routine needs to run. */
  _hasUrgentPreemption(ctx) {
    if (!this._peerRoutines) return false;
    return this._peerRoutines.some(
      r => r.priority > this.priority && r.urgent && r.canRun(ctx),
    );
  }

  async execute(_char) {
    throw new Error(`${this.name}: execute() not implemented`);
  }
}
