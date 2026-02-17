/**
 * Base class for all bot tasks.
 *
 * Subclasses implement:
 *   canRun(char)  → boolean — prerequisites check
 *   execute(char) → boolean — for loop tasks: true=continue, false=stop
 */
export class BaseTask {
  constructor({ name, priority = 0, loop = false }) {
    this.name = name;
    this.priority = priority;
    this.loop = loop;
  }

  canRun(_char) {
    throw new Error(`${this.name}: canRun() not implemented`);
  }

  canBePreempted(_ctx) {
    return true;
  }

  async execute(_char) {
    throw new Error(`${this.name}: execute() not implemented`);
  }
}
