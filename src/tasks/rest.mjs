import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';
import { restUntil } from '../helpers.mjs';

const TRIGGER_PCT = 40;
const TARGET_PCT = 80;

export class RestTask extends BaseTask {
  constructor() {
    super({ name: 'Rest', priority: 100, loop: false });
  }

  canRun(_char) {
    return state.hpPercent() < TRIGGER_PCT;
  }

  async execute(_char) {
    await restUntil(TARGET_PCT);
  }
}
