import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo, gatherOnce, withdrawPlanFromBank, rawMaterialNeeded } from '../helpers.mjs';
import * as gameData from '../services/game-data.mjs';

/**
 * Gathers raw resources and crafts intermediates needed for the current
 * craft target. Works in tandem with CraftGearTask — reads ctx.craftTarget
 * to know what materials to collect.
 *
 * Uses resolveRecipeChain() to flatten multi-level recipes into an ordered
 * production plan (gather raw → craft intermediates), then executes each
 * step in sequence.
 */
export class GatherMaterialsTask extends BaseTask {
  constructor({ priority = 11 } = {}) {
    super({ name: 'Gather Materials', priority, loop: true });
    this._plan = null;
    this._planFor = null;
    this._currentStep = null;
    this._bankChecked = false;
  }

  canRun(ctx) {
    if (!ctx.craftTarget?.recipe?.items) return false;
    if (ctx.inventoryFull()) return false;

    // Rebuild plan if craft target changed
    if (this._planFor !== ctx.craftTarget.itemCode) {
      this._plan = gameData.resolveRecipeChain(ctx.craftTarget.recipe);
      this._planFor = ctx.craftTarget.itemCode;

      this._bankChecked = false;

      if (!this._plan) {
        log.warn(`[${ctx.name}] Cannot resolve recipe chain for ${ctx.craftTarget.itemCode}`);
        return false;
      }

      log.info(`[${ctx.name}] Production plan for ${ctx.craftTarget.itemCode}: ${this._plan.map(s => `${s.type}:${s.itemCode}(${s.quantity})`).join(' → ')}`);
    }

    if (!this._plan) return false;

    this._currentStep = this._findNextStep(ctx);
    return this._currentStep !== null;
  }

  _rawMaterialNeeded(ctx, itemCode) {
    return rawMaterialNeeded(ctx, this._plan, itemCode);
  }

  _findNextStep(ctx) {
    for (const step of this._plan) {
      // Bank-only items (monster drops, etc.) — skip if have enough, can't gather
      if (step.type === 'bank') {
        if (ctx.itemCount(step.itemCode) >= step.quantity) continue;
        // Can't do anything about this — bank withdrawal already attempted
        continue;
      }

      if (step.type === 'gather') {
        const needed = this._rawMaterialNeeded(ctx, step.itemCode);
        if (ctx.itemCount(step.itemCode) >= needed) continue;

        if (ctx.skillLevel(step.resource.skill) < step.resource.level) {
          log.warn(`[${ctx.name}] Need ${step.resource.skill} lv${step.resource.level} to gather ${step.itemCode}, have lv${ctx.skillLevel(step.resource.skill)}`);
          continue;
        }
        return step;
      }

      if (step.type === 'craft') {
        if (ctx.itemCount(step.itemCode) >= step.quantity) continue;

        // Check sub-materials are ready for at least one craft
        const ready = step.recipe.items.every(
          mat => ctx.itemCount(mat.code) >= mat.quantity
        );
        if (!ready) continue;

        if (ctx.skillLevel(step.recipe.skill) < step.recipe.level) {
          log.warn(`[${ctx.name}] Need ${step.recipe.skill} lv${step.recipe.level} to craft ${step.itemCode}, have lv${ctx.skillLevel(step.recipe.skill)}`);
          continue;
        }
        return step;
      }
    }
    return null;
  }

  async _withdrawFromBank(ctx) {
    const withdrawn = await withdrawPlanFromBank(ctx, this._plan);
    if (withdrawn.length > 0) {
      log.info(`[${ctx.name}] Withdrew from bank: ${withdrawn.join(', ')}`);
    }
  }

  async execute(ctx) {
    if (!this._bankChecked) {
      this._bankChecked = true;
      await this._withdrawFromBank(ctx);
      // Re-evaluate after withdrawal — some steps may now be complete
      this._currentStep = this._findNextStep(ctx);
    }

    if (!this._currentStep) return false;

    if (this._currentStep.type === 'gather') {
      return await this._executeGather(ctx, this._currentStep);
    }
    if (this._currentStep.type === 'craft') {
      return await this._executeCraft(ctx, this._currentStep);
    }
    return false;
  }

  async _executeGather(ctx, step) {
    if (ctx.inventoryFull()) return false;

    const location = await gameData.getResourceLocation(step.resource.code);
    if (!location) {
      log.error(`[${ctx.name}] No map location for resource ${step.resource.code}`);
      return false;
    }

    await moveTo(ctx, location.x, location.y);

    const result = await gatherOnce(ctx);
    const items = result.details?.items || result.items || [];
    const gathered = items.find(i => i.code === step.itemCode);
    const needed = this._rawMaterialNeeded(ctx, step.itemCode) - ctx.itemCount(step.itemCode);
    const forItem = ctx.craftTarget?.itemCode || '?';
    log.info(`[${ctx.name}] Gathering ${step.itemCode} for ${forItem}: ${gathered ? `+${gathered.quantity}` : 'nothing'} (need ${needed} more)`);

    this._currentStep = this._findNextStep(ctx);
    if (!this._currentStep) return false;

    return !ctx.inventoryFull();
  }

  async _executeCraft(ctx, step) {
    const workshops = await gameData.getWorkshops();
    const workshop = workshops[step.recipe.skill];
    if (!workshop) {
      log.error(`[${ctx.name}] No workshop found for ${step.recipe.skill}`);
      return false;
    }

    const needed = step.quantity - ctx.itemCount(step.itemCode);
    const canCraft = Math.min(
      needed,
      ...step.recipe.items.map(mat => Math.floor(ctx.itemCount(mat.code) / mat.quantity))
    );
    if (canCraft <= 0) return false;

    log.info(`[${ctx.name}] Crafting intermediate: ${step.itemCode} x${canCraft} at ${step.recipe.skill} workshop`);
    await moveTo(ctx, workshop.x, workshop.y);

    for (let i = 0; i < canCraft; i++) {
      const result = await api.craft(step.itemCode, 1, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
    }

    log.info(`[${ctx.name}] Crafted ${step.itemCode} (have ${ctx.itemCount(step.itemCode)}/${step.quantity})`);

    this._currentStep = this._findNextStep(ctx);
    if (!this._currentStep) return false;

    return !ctx.inventoryFull();
  }
}
