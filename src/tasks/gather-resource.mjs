import { BaseTask } from './base.mjs';
import * as log from '../log.mjs';
import { moveTo, gatherOnce, equipForGathering } from '../helpers.mjs';
import * as gameData from '../services/game-data.mjs';

export class GatherResourceTask extends BaseTask {
  /**
   * @param {string} resource — resource code from the API (e.g. "copper_rocks", "ash_tree")
   * @param {object} [opts]
   * @param {number} [opts.priority=10]
   */
  constructor(resource, { priority = 10 } = {}) {
    const res = gameData.getResource(resource);
    if (!res) throw new Error(`Unknown resource: ${resource}`);

    super({ name: `Gather ${resource}`, priority, loop: true });
    this.resource = resource;
    this.res = res;
  }

  canRun(ctx) {
    if (ctx.skillLevel(this.res.skill) < this.res.level) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    const location = await gameData.getResourceLocation(this.resource);
    if (!location) {
      log.error(`[${ctx.name}] No map location found for resource ${this.resource}`);
      return false;
    }

    // Equip optimal gathering gear (tool + prospecting)
    await equipForGathering(ctx, this.res.skill);

    await moveTo(ctx, location.x, location.y);

    const result = await gatherOnce(ctx);
    const items = result.details?.items || [];
    log.info(`[${ctx.name}] ${this.resource}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);

    return !ctx.inventoryFull();
  }
}
