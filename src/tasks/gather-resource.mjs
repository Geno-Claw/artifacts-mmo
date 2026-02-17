import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';
import * as log from '../log.mjs';
import { moveTo, gatherOnce } from '../helpers.mjs';
import { RESOURCES } from '../data/locations.mjs';

export class GatherResourceTask extends BaseTask {
  /**
   * @param {string} resource — key from RESOURCES table
   * @param {object} [opts]
   * @param {number} [opts.priority=10]
   */
  constructor(resource, { priority = 10 } = {}) {
    const res = RESOURCES[resource];
    if (!res) throw new Error(`Unknown resource: ${resource}`);

    super({ name: `Gather ${resource}`, priority, loop: true });
    this.resource = resource;
    this.res = res;
  }

  canRun(_char) {
    if (state.skillLevel(this.res.skill) < this.res.level) return false;
    if (state.inventoryFull()) return false;
    return true;
  }

  async execute(_char) {
    await moveTo(this.res.x, this.res.y);

    const result = await gatherOnce();
    const items = result.details?.items || [];
    log.info(`${this.resource}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);

    return !state.inventoryFull();
  }
}
