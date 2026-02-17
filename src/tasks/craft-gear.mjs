import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo } from '../helpers.mjs';
import * as gameData from '../services/game-data.mjs';

/**
 * Identifies the best craftable gear upgrade and crafts it when all materials
 * are in inventory. Works in tandem with GatherMaterialsTask which collects
 * the materials.
 */
export class CraftGearTask extends BaseTask {
  constructor({ priority = 12, checkInterval = 600_000 } = {}) {
    super({ name: 'Craft Gear', priority, loop: false });
    this.checkInterval = checkInterval;
    this._lastCheck = 0;
    this._lastLogTarget = null;
  }

  canRun(ctx) {
    const now = Date.now();
    if (now - this._lastCheck >= this.checkInterval || !ctx.craftTarget) {
      ctx.craftTarget = this._findCraftTarget(ctx);
      this._lastCheck = now;
    }
    if (!ctx.craftTarget) return false;

    const ready = this._hasAllMaterials(ctx, ctx.craftTarget.recipe);
    if (!ready && this._lastLogTarget !== ctx.craftTarget.itemCode) {
      this._lastLogTarget = ctx.craftTarget.itemCode;
      const missing = ctx.craftTarget.recipe.items
        .filter(m => !ctx.hasItem(m.code, m.quantity))
        .map(m => `${m.code} (${ctx.itemCount(m.code)}/${m.quantity})`);
      log.info(`[${ctx.name}] Craft ${ctx.craftTarget.itemCode}: need ${missing.join(', ')}`);
    }
    if (ready) this._lastLogTarget = null;
    return ready;
  }

  _findCraftTarget(ctx) {
    const target = gameData.findBestUpgrade(ctx);
    if (target) {
      log.info(`[${ctx.name}] Craft target: ${target.itemCode} for ${target.slot} (+${target.scoreDelta.toFixed(1)} score)`);
    }
    return target;
  }

  _hasAllMaterials(ctx, recipe) {
    if (!recipe?.items) return false;
    for (const mat of recipe.items) {
      if (!ctx.hasItem(mat.code, mat.quantity)) return false;
    }
    return true;
  }

  async execute(ctx) {
    const { itemCode, slot, recipe } = ctx.craftTarget;

    const workshops = await gameData.getWorkshops();
    const workshop = workshops[recipe.skill];
    if (!workshop) {
      log.error(`[${ctx.name}] No workshop found for ${recipe.skill}`);
      ctx.craftTarget = null;
      return;
    }

    log.info(`[${ctx.name}] Crafting ${itemCode} at ${recipe.skill} workshop (${workshop.x},${workshop.y})`);
    await moveTo(ctx, workshop.x, workshop.y);

    const result = await api.craft(itemCode, 1, ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();

    log.info(`[${ctx.name}] Crafted ${itemCode}!`);

    // Equip the crafted item so _findCraftTarget won't re-target it
    const currentEquip = ctx.get()[`${slot}_slot`];
    if (currentEquip) {
      log.info(`[${ctx.name}] Unequipping ${currentEquip} from ${slot}`);
      const ur = await api.unequipItem(slot, ctx.name);
      await api.waitForCooldown(ur);
      await ctx.refresh();
    }
    log.info(`[${ctx.name}] Equipping ${itemCode} in ${slot}`);
    const er = await api.equipItem(slot, itemCode, ctx.name);
    await api.waitForCooldown(er);
    await ctx.refresh();

    ctx.craftTarget = null; // Re-evaluate on next cycle
  }
}
