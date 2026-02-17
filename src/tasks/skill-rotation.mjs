/**
 * Skill Rotation Task — randomly cycles between gathering, crafting,
 * combat, and NPC tasks with goal-based durations.
 *
 * Runs as a low-priority loop task. Background tasks (rest, bank,
 * auto-equip) interrupt via higher priority in the scheduler.
 */
import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import { SkillRotation } from '../services/skill-rotation.mjs';
import { canBeatMonster } from '../services/combat-simulator.mjs';
import { moveTo, gatherOnce, fightOnce, restBeforeFight, withdrawItem } from '../helpers.mjs';
import { TASKS_MASTER } from '../data/locations.mjs';

const GATHERING_SKILLS = new Set(['mining', 'woodcutting', 'fishing']);
const CRAFTING_SKILLS = new Set(['cooking', 'alchemy', 'weaponcrafting', 'gearcrafting', 'jewelrycrafting']);

export class SkillRotationTask extends BaseTask {
  constructor({ priority = 5, maxLosses = 2, ...rotationCfg } = {}) {
    super({ name: 'Skill Rotation', priority, loop: true });
    this.rotation = new SkillRotation(rotationCfg);
    this.maxLosses = maxLosses;
  }

  canRun(ctx) {
    if (ctx.inventoryFull()) return false;
    return true;
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

    await moveTo(ctx, loc.x, loc.y);
    await restBeforeFight(ctx, this.rotation.monster.code);

    const result = await fightOnce(ctx);
    const f = result.fight;
    const cr = f.characters?.find(ch => ch.character_name === ctx.name)
            || f.characters?.[0] || {};
    const monster = this.rotation.monster;

    if (f.result === 'win') {
      ctx.clearLosses(monster.code);
      this.rotation.recordProgress(1);
      const drops = cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '';
      log.info(`[${ctx.name}] ${monster.code}: WIN ${f.turns}t | +${cr.xp || 0}xp +${cr.gold || 0}g${drops ? ' | ' + drops : ''} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
      return !ctx.inventoryFull();
    } else {
      ctx.recordLoss(monster.code);
      const losses = ctx.consecutiveLosses(monster.code);
      log.warn(`[${ctx.name}] ${monster.code}: LOSS ${f.turns}t (${losses} losses)`);

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

    // Withdraw matching ingredients from bank once per recipe
    if (!this.rotation.bankChecked) {
      this.rotation.bankChecked = true;
      await this._withdrawFromBank(ctx);
    }

    // Walk through production plan steps
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];

      if (step.type === 'bank') {
        // Must come from bank (monster drops, etc.) — already withdrawn above
        const have = ctx.itemCount(step.itemCode);
        if (have >= step.quantity) continue;
        // Don't have enough and can't gather it — skip this recipe
        log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: need ${step.quantity}x ${step.itemCode} from bank, have ${have} — skipping recipe`);
        await this.rotation.forceRotate(ctx);
        return true;
      }

      if (step.type === 'gather') {
        // Check if we already have enough (accounting for intermediates already crafted)
        const needed = this._rawMaterialNeeded(ctx, plan, step.itemCode);
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
        // Skip intermediates we already have enough of (final step is goal-driven)
        if (i < plan.length - 1 && ctx.itemCount(step.itemCode) >= step.quantity) continue;

        // Check if we have all ingredients for this intermediate/final craft
        const craftItem = gameData.getItem(step.itemCode);
        if (!craftItem?.craft) continue;

        const haveAll = craftItem.craft.items.every(
          mat => ctx.itemCount(mat.code) >= mat.quantity
        );
        if (!haveAll) continue; // need to gather more, loop will handle it

        // Craft at the workshop
        const workshops = await gameData.getWorkshops();
        const ws = workshops[craftItem.craft.skill];
        if (!ws) {
          log.warn(`[${ctx.name}] No workshop found for ${craftItem.craft.skill}`);
          await this.rotation.forceRotate(ctx);
          return true;
        }

        await moveTo(ctx, ws.x, ws.y);
        const result = await api.craft(step.itemCode, 1, ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();

        log.info(`[${ctx.name}] ${this.rotation.currentSkill}: crafted ${step.itemCode}`);

        // If this is the final step, record progress
        if (i === plan.length - 1) {
          this.rotation.recordProgress(1);
          log.info(`[${ctx.name}] ${this.rotation.currentSkill}: ${recipe.code} complete (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);

          // Allow re-withdrawal from bank for next iteration
          this.rotation.bankChecked = false;

          // Auto-equip if this was an upgrade craft
          if (this.rotation.isUpgrade && this.rotation.upgradeTarget) {
            await this._equipUpgrade(ctx, this.rotation.upgradeTarget);
          }
        }
        return true;
      }
    }

    // If we get here, couldn't make progress — try next iteration
    // (bank deposit may have freed inventory, or we already have materials)
    return !ctx.inventoryFull();
  }

  // --- Dynamic gather quantity (accounts for already-crafted intermediates) ---

  _rawMaterialNeeded(ctx, plan, itemCode) {
    let total = 0;
    let usedByCraft = false;

    for (const step of plan) {
      if (step.type !== 'craft') continue;
      for (const mat of step.recipe.items) {
        if (mat.code !== itemCode) continue;
        usedByCraft = true;
        // Final step is goal-driven — always need 1 batch of materials
        const isFinalStep = step === plan[plan.length - 1];
        const remaining = isFinalStep ? 1 : Math.max(0, step.quantity - ctx.itemCount(step.itemCode));
        total += remaining * mat.quantity;
      }
    }

    if (!usedByCraft) {
      const gatherStep = plan.find(s => s.type === 'gather' && s.itemCode === itemCode);
      return gatherStep ? gatherStep.quantity : 0;
    }

    return total;
  }

  // --- Bank withdrawal for crafting ---

  async _withdrawFromBank(ctx) {
    const plan = this.rotation.productionPlan;
    if (!plan) return;

    const bank = await gameData.getBankItems(true);
    const withdrawn = [];

    // Check steps in reverse (crafted intermediates first — can skip gather steps)
    const stepsReversed = [...plan].reverse();
    for (const step of stepsReversed) {
      if (ctx.inventoryFull()) break;

      const have = ctx.itemCount(step.itemCode);
      const needed = step.quantity - have;
      if (needed <= 0) continue;

      const inBank = bank.get(step.itemCode) || 0;
      if (inBank <= 0) continue;

      const space = ctx.inventoryCapacity() - ctx.inventoryCount();
      const toWithdraw = Math.min(needed, inBank, space);
      if (toWithdraw <= 0) continue;

      try {
        await withdrawItem(ctx, step.itemCode, toWithdraw);
        withdrawn.push(`${step.itemCode} x${toWithdraw}`);
      } catch (err) {
        log.warn(`[${ctx.name}] Could not withdraw ${step.itemCode}: ${err.message}`);
      }
    }

    if (withdrawn.length > 0) {
      log.info(`[${ctx.name}] Rotation crafting: withdrew from bank: ${withdrawn.join(', ')}`);
    }
  }

  // --- Equip upgrade after crafting ---

  async _equipUpgrade(ctx, upgradeTarget) {
    const { itemCode, slot } = upgradeTarget;

    const currentEquip = ctx.get()[`${slot}_slot`];
    if (currentEquip) {
      log.info(`[${ctx.name}] Unequipping ${currentEquip} from ${slot}`);
      const ur = await api.unequipItem(slot, ctx.name);
      await api.waitForCooldown(ur);
      await ctx.refresh();
    }

    log.info(`[${ctx.name}] Equipping upgrade ${itemCode} in ${slot}`);
    const er = await api.equipItem(slot, itemCode, ctx.name);
    await api.waitForCooldown(er);
    await ctx.refresh();
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

    if (!canBeatMonster(ctx, monster)) {
      log.warn(`[${ctx.name}] NPC Task: simulation predicts loss vs ${monster}, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    if (ctx.consecutiveLosses(monster) >= this.maxLosses) {
      log.warn(`[${ctx.name}] NPC Task: too many losses vs ${monster}, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    await moveTo(ctx, monsterLoc.x, monsterLoc.y);
    await restBeforeFight(ctx, monster);

    const result = await fightOnce(ctx);
    const f = result.fight;
    const cr = f.characters?.find(ch => ch.character_name === ctx.name)
            || f.characters?.[0] || {};

    if (f.result === 'win') {
      ctx.clearLosses(monster);
      const drops = cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '';
      const fresh = ctx.get();
      log.info(`[${ctx.name}] ${monster}: WIN ${f.turns}t | +${cr.xp || 0}xp +${cr.gold || 0}g${drops ? ' | ' + drops : ''} [task: ${fresh.task_progress}/${fresh.task_total}]`);
    } else {
      ctx.recordLoss(monster);
      log.warn(`[${ctx.name}] ${monster}: LOSS ${f.turns}t (${ctx.consecutiveLosses(monster)} losses)`);
      return false;
    }

    return !ctx.inventoryFull();
  }
}
