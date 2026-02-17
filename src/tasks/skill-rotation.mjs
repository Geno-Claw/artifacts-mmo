/**
 * Skill Rotation Task — randomly cycles between gathering, crafting,
 * combat, and NPC tasks with goal-based durations.
 *
 * Runs as a low-priority loop task. Background tasks (rest, bank)
 * interrupt via higher priority in the scheduler.
 */
import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import { SkillRotation } from '../services/skill-rotation.mjs';
import { moveTo, gatherOnce, fightOnce, restBeforeFight, parseFightResult, withdrawPlanFromBank, rawMaterialNeeded, equipForCombat } from '../helpers.mjs';
import { TASKS_MASTER, MAX_LOSSES_DEFAULT } from '../data/locations.mjs';

const GATHERING_SKILLS = new Set(['mining', 'woodcutting', 'fishing']);
const CRAFTING_SKILLS = new Set(['cooking', 'alchemy', 'weaponcrafting', 'gearcrafting', 'jewelrycrafting']);

export class SkillRotationTask extends BaseTask {
  constructor({ priority = 5, maxLosses = MAX_LOSSES_DEFAULT, ...rotationCfg } = {}) {
    super({ name: 'Skill Rotation', priority, loop: true });
    this.rotation = new SkillRotation(rotationCfg);
    this.maxLosses = maxLosses;
    this._currentBatch = 1;
  }

  canRun(ctx) {
    if (ctx.inventoryFull()) return false;
    return true;
  }

  canBePreempted(_ctx) {
    return !this.rotation.currentSkill || this.rotation.isGoalComplete();
  }

  async execute(ctx) {
    // Pick or rotate skill
    if (!this.rotation.currentSkill || this.rotation.isGoalComplete()) {
      const skill = await this.rotation.pickNext(ctx);
      if (!skill) {
        log.warn(`[${ctx.name}] Rotation: no viable skills, idling`);
        return false;
      }
      log.info(`[${ctx.name}] Rotation: switched to ${skill} (goal: 0/${this.rotation.goalTarget})`);
    }

    const skill = this.rotation.currentSkill;

    if (GATHERING_SKILLS.has(skill)) {
      return this._executeGathering(ctx);
    }
    if (CRAFTING_SKILLS.has(skill)) {
      return this._executeCrafting(ctx);
    }
    if (skill === 'combat') {
      return this._executeCombat(ctx);
    }
    if (skill === 'npc_task') {
      return this._executeNpcTask(ctx);
    }

    // Unknown skill — force rotate
    await this.rotation.forceRotate(ctx);
    return true;
  }

  // --- Gathering (mining, woodcutting, fishing) ---

  async _executeGathering(ctx) {
    const loc = this.rotation.resourceLoc;
    if (!loc) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Smelt/process raw materials before gathering more
    const smelted = await this._trySmelting(ctx);
    if (smelted) return !ctx.inventoryFull();

    await moveTo(ctx, loc.x, loc.y);
    const result = await gatherOnce(ctx);

    const items = result.details?.items || [];
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
    this.rotation.recordProgress(totalQty);

    const res = this.rotation.resource;
    log.info(`[${ctx.name}] ${res.code}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);

    return !ctx.inventoryFull();
  }

  // --- Smelting (process raw ores/materials before gathering more) ---

  async _trySmelting(ctx) {
    const skill = this.rotation.currentSkill;
    const level = ctx.skillLevel(skill);

    const recipes = gameData.findItems({ craftSkill: skill, maxLevel: level });
    if (recipes.length === 0) return false;

    // Sort highest level first for best XP
    recipes.sort((a, b) => b.craft.level - a.craft.level);

    for (const item of recipes) {
      if (!item.craft?.items) continue;
      const maxQty = Math.min(
        ...item.craft.items.map(mat => Math.floor(ctx.itemCount(mat.code) / mat.quantity))
      );
      if (maxQty <= 0) continue;

      const workshops = await gameData.getWorkshops();
      const ws = workshops[skill];
      if (!ws) return false;

      await moveTo(ctx, ws.x, ws.y);
      const result = await api.craft(item.code, maxQty, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();

      this.rotation.recordProgress(maxQty);
      log.info(`[${ctx.name}] ${skill}: smelted ${item.code} x${maxQty} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
      return true;
    }

    return false;
  }

  // --- Combat ---

  async _executeCombat(ctx) {
    const loc = this.rotation.monsterLoc;
    if (!loc) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Optimize gear for target monster (cached — only runs once per target)
    await equipForCombat(ctx, this.rotation.monster.code);

    await moveTo(ctx, loc.x, loc.y);
    await restBeforeFight(ctx, this.rotation.monster.code);

    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);
    const monster = this.rotation.monster;

    if (r.win) {
      ctx.clearLosses(monster.code);
      this.rotation.recordProgress(1);
      log.info(`[${ctx.name}] ${monster.code}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
      return !ctx.inventoryFull();
    } else {
      ctx.recordLoss(monster.code);
      const losses = ctx.consecutiveLosses(monster.code);
      log.warn(`[${ctx.name}] ${monster.code}: LOSS ${r.turns}t (${losses} losses)`);

      if (losses >= this.maxLosses) {
        log.info(`[${ctx.name}] Too many losses, rotating to different skill`);
        await this.rotation.forceRotate(ctx);
      }
      return true;
    }
  }

  // --- Crafting ---

  async _executeCrafting(ctx) {
    const plan = this.rotation.productionPlan;
    const recipe = this.rotation.recipe;
    if (!plan || !recipe) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Append final craft step if not already in the plan
    // (resolveRecipeChain only returns dependency steps, not the final recipe)
    if (plan.length === 0 || plan[plan.length - 1].itemCode !== recipe.code) {
      plan.push({ type: 'craft', itemCode: recipe.code, recipe: recipe.craft, quantity: 1 });
    }

    // Re-withdraw if bank task deposited our materials
    if (this.rotation.bankChecked && ctx.inventoryCount() === 0) {
      this.rotation.bankChecked = false;
    }

    // Withdraw matching ingredients from bank (scaled for batch)
    if (!this.rotation.bankChecked) {
      this.rotation.bankChecked = true;
      this._currentBatch = this._batchSize(ctx);
      await this._withdrawFromBank(ctx, this._currentBatch);
    }

    // Walk through production plan steps
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];

      if (step.type === 'bank') {
        // Must come from bank (monster drops, etc.) — already withdrawn above
        const have = ctx.itemCount(step.itemCode);
        if (have >= step.quantity) continue; // have enough for at least 1 craft
        // Don't have enough and can't gather it — skip this recipe
        log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: need ${step.quantity}x ${step.itemCode} from bank, have ${have} — skipping recipe`);
        await this.rotation.forceRotate(ctx);
        return true;
      }

      if (step.type === 'gather') {
        // Check if we already have enough (accounting for batch + intermediates)
        const needed = rawMaterialNeeded(ctx, plan, step.itemCode, this._currentBatch);
        if (ctx.itemCount(step.itemCode) >= needed) continue;

        // Gather one batch from the resource
        const loc = await gameData.getResourceLocation(step.resource.code);
        if (!loc) {
          log.warn(`[${ctx.name}] Cannot find location for ${step.resource.code}, skipping recipe`);
          await this.rotation.forceRotate(ctx);
          return true;
        }

        await moveTo(ctx, loc.x, loc.y);
        const result = await gatherOnce(ctx);
        const items = result.details?.items || [];
        log.info(`[${ctx.name}] ${this.rotation.currentSkill}: gathering ${step.itemCode} for ${recipe.code} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);
        return !ctx.inventoryFull();
      }

      if (step.type === 'craft') {
        // Skip intermediates we already have enough of (scaled by batch)
        if (i < plan.length - 1 && ctx.itemCount(step.itemCode) >= step.quantity * this._currentBatch) continue;

        // Calculate how many we can craft with available materials
        const craftItem = gameData.getItem(step.itemCode);
        if (!craftItem?.craft) continue;

        let craftQty;
        if (i === plan.length - 1) {
          // Final step: craft as many as materials allow, up to remaining goal
          craftQty = Math.min(
            this.rotation.goalTarget - this.rotation.goalProgress,
            ...craftItem.craft.items.map(mat =>
              Math.floor(ctx.itemCount(mat.code) / mat.quantity)
            )
          );
        } else {
          // Intermediate step: craft enough for the batch
          const neededQty = step.quantity * this._currentBatch - ctx.itemCount(step.itemCode);
          craftQty = Math.min(
            neededQty,
            ...craftItem.craft.items.map(mat =>
              Math.floor(ctx.itemCount(mat.code) / mat.quantity)
            )
          );
        }
        if (craftQty <= 0) continue; // need to gather more, loop will handle it

        // Craft at the workshop
        const workshops = await gameData.getWorkshops();
        const ws = workshops[craftItem.craft.skill];
        if (!ws) {
          log.warn(`[${ctx.name}] No workshop found for ${craftItem.craft.skill}`);
          await this.rotation.forceRotate(ctx);
          return true;
        }

        await moveTo(ctx, ws.x, ws.y);
        const result = await api.craft(step.itemCode, craftQty, ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();

        log.info(`[${ctx.name}] ${this.rotation.currentSkill}: crafted ${step.itemCode} x${craftQty}`);

        // If this is the final step, record progress
        if (i === plan.length - 1) {
          this.rotation.recordProgress(craftQty);
          log.info(`[${ctx.name}] ${this.rotation.currentSkill}: ${recipe.code} x${craftQty} complete (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);

          // Allow re-withdrawal from bank for next batch
          this.rotation.bankChecked = false;
          this._currentBatch = 1;

        }
        return true;
      }
    }

    // If we get here, couldn't make progress — try next iteration
    // (bank deposit may have freed inventory, or we already have materials)
    return !ctx.inventoryFull();
  }

  // --- Batch size calculation ---

  _batchSize(ctx) {
    const remaining = this.rotation.goalTarget - this.rotation.goalProgress;
    if (remaining <= 1) return 1;

    const plan = this.rotation.productionPlan;
    if (!plan) return 1;

    // Sum material quantities per single craft (bank + gather steps)
    let materialsPerCraft = 0;
    for (const step of plan) {
      if (step.type === 'bank' || step.type === 'gather') {
        materialsPerCraft += step.quantity;
      }
    }
    if (materialsPerCraft === 0) materialsPerCraft = 1;

    // Cap by available inventory space
    const space = ctx.inventoryCapacity() - ctx.inventoryCount();
    const spaceLimit = Math.floor(space / materialsPerCraft);

    return Math.max(1, Math.min(remaining, spaceLimit));
  }

  // --- Bank withdrawal for crafting ---

  async _withdrawFromBank(ctx, batchSize = 1) {
    const plan = this.rotation.productionPlan;
    if (!plan) return;

    const withdrawn = await withdrawPlanFromBank(ctx, plan, batchSize);
    if (withdrawn.length > 0) {
      log.info(`[${ctx.name}] Rotation crafting: withdrew from bank: ${withdrawn.join(', ')}`);
    }
  }

  // --- NPC Tasks ---

  async _executeNpcTask(ctx) {
    // Accept a task if we don't have one
    if (!ctx.hasTask()) {
      await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
      const result = await api.acceptTask(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      const c = ctx.get();
      log.info(`[${ctx.name}] NPC Task: accepted ${c.task} (0/${c.task_total})`);
      return true;
    }

    // Complete task if done
    if (ctx.taskComplete()) {
      await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
      const result = await api.completeTask(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      this.rotation.recordProgress(1);
      log.info(`[${ctx.name}] NPC Task: completed (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);

      // Exchange task coins for rewards if targets are configured/detected
      await this._exchangeTaskCoins(ctx);
      return true;
    }

    // Fight the task monster
    const c = ctx.get();
    const monster = c.task;
    const monsterLoc = await gameData.getMonsterLocation(monster);

    if (!monsterLoc) {
      log.warn(`[${ctx.name}] NPC Task: can't find monster ${monster}, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget; // force goal complete
      return true;
    }

    const monsterData = gameData.getMonster(monster);
    if (monsterData && monsterData.level > c.level) {
      log.warn(`[${ctx.name}] NPC Task: ${monster} too strong (lv${monsterData.level} > lv${c.level}), skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    if (ctx.consecutiveLosses(monster) >= this.maxLosses) {
      log.warn(`[${ctx.name}] NPC Task: too many losses vs ${monster}, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    // Optimize gear for NPC task monster — also validates fight is winnable
    const { simResult } = await equipForCombat(ctx, monster);
    if (!simResult || !simResult.win || simResult.hpLostPercent > 80) {
      log.warn(`[${ctx.name}] NPC Task: simulation predicts loss vs ${monster} even with optimal gear, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    await moveTo(ctx, monsterLoc.x, monsterLoc.y);
    await restBeforeFight(ctx, monster);

    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monster);
      const fresh = ctx.get();
      log.info(`[${ctx.name}] ${monster}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} [task: ${fresh.task_progress}/${fresh.task_total}]`);
    } else {
      ctx.recordLoss(monster);
      log.warn(`[${ctx.name}] ${monster}: LOSS ${r.turns}t (${ctx.consecutiveLosses(monster)} losses)`);
      return false;
    }

    return !ctx.inventoryFull();
  }

  // --- Task coin exchange ---

  async _exchangeTaskCoins(ctx) {
    const targets = this.rotation.getExchangeTargets();
    if (targets.size === 0) return;

    while (ctx.taskCoins() >= 6) {
      // Check if all targets met (force-refresh bank)
      const bank = await gameData.getBankItems(true);
      if (!this.rotation.hasUnmetExchangeTargets(bank, ctx)) {
        log.info(`[${ctx.name}] Task Exchange: all collection targets met, saving coins`);
        break;
      }

      // Check inventory space (rewards give 1-2 items)
      if (ctx.inventoryCount() + 2 >= ctx.inventoryCapacity()) {
        log.info(`[${ctx.name}] Task Exchange: inventory too full, deferring`);
        break;
      }

      // Already at task master after completing task
      await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
      try {
        const result = await api.taskExchange(ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();
        log.info(`[${ctx.name}] Task Exchange: exchanged 6 coins (${ctx.taskCoins()} remaining)`);
      } catch (err) {
        log.warn(`[${ctx.name}] Task Exchange failed: ${err.message}`);
        break;
      }
    }
  }
}
