/**
 * Skill Rotation Routine — randomly cycles between gathering, crafting,
 * combat, and NPC tasks with goal-based durations.
 *
 * Runs as a low-priority loop routine. Background routines (rest, bank)
 * interrupt via higher priority in the scheduler.
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import { SkillRotation } from '../services/skill-rotation.mjs';
import { moveTo, gatherOnce, fightOnce, restBeforeFight, parseFightResult, withdrawPlanFromBank, rawMaterialNeeded, equipForCombat, withdrawFoodForFights, equipForGathering } from '../helpers.mjs';
import { TASKS_MASTER, MAX_LOSSES_DEFAULT } from '../data/locations.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';
import { depositBankItems, withdrawBankItems } from '../services/bank-ops.mjs';
import {
  claimOrder,
  getOrderBoardSnapshot,
  listClaimableOrders,
  markCharBlocked,
  releaseClaim,
  renewClaim,
} from '../services/order-board.mjs';
import { optimizeForMonster } from '../services/gear-optimizer.mjs';
import { sortOrdersForClaim } from '../services/order-priority.mjs';

const GATHERING_SKILLS = new Set(['mining', 'woodcutting', 'fishing']);
const CRAFTING_SKILLS = new Set(['cooking', 'alchemy', 'weaponcrafting', 'gearcrafting', 'jewelrycrafting']);
const DEFAULT_ORDER_BOARD = Object.freeze({
  enabled: false,
  createOrders: false,
  fulfillOrders: false,
  leaseMs: 120_000,
  blockedRetryMs: 600_000,
});
const TASK_COIN_CODE = 'tasks_coin';
const TASK_EXCHANGE_COST = 6;
const PROACTIVE_EXCHANGE_BACKOFF_MS = 60_000;
const RESERVE_PCT = 0.10;
const RESERVE_MIN = 8;
const RESERVE_MAX = 20;

let taskExchangeLockHolder = null;

function normalizeOrderBoardConfig(cfg = {}) {
  const input = cfg && typeof cfg === 'object' ? cfg : {};
  const enabled = input.enabled === true;
  const leaseMs = Number(input.leaseMs);
  const blockedRetryMs = Number(input.blockedRetryMs);
  const createOrders = typeof input.createOrders === 'boolean' ? input.createOrders : enabled;
  const fulfillOrders = typeof input.fulfillOrders === 'boolean' ? input.fulfillOrders : enabled;

  return {
    enabled,
    createOrders,
    fulfillOrders,
    leaseMs: Number.isFinite(leaseMs) && leaseMs > 0 ? Math.floor(leaseMs) : DEFAULT_ORDER_BOARD.leaseMs,
    blockedRetryMs: Number.isFinite(blockedRetryMs) && blockedRetryMs > 0
      ? Math.floor(blockedRetryMs)
      : DEFAULT_ORDER_BOARD.blockedRetryMs,
  };
}

export class SkillRotationRoutine extends BaseRoutine {
  constructor({ priority = 5, maxLosses = MAX_LOSSES_DEFAULT, orderBoard = {}, ...rotationCfg } = {}) {
    super({ name: 'Skill Rotation', priority, loop: true });
    this.rotation = new SkillRotation({ ...rotationCfg, orderBoard });
    this.maxLosses = maxLosses;
    this.orderBoard = normalizeOrderBoardConfig(orderBoard);
    this._currentBatch = 1;
    this._foodWithdrawn = false;
    this._activeOrderClaim = null;
    this._nextProactiveExchangeAt = 0;
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
      this._foodWithdrawn = false;
      log.info(`[${ctx.name}] Rotation: switched to ${skill} (goal: 0/${this.rotation.goalTarget})`);
    }

    const skill = this.rotation.currentSkill;
    const proactive = await this._maybeRunProactiveExchange(ctx, {
      trigger: 'rotation_setup',
    });
    if (proactive.attempted) {
      return true;
    }

    if (skill === 'alchemy') {
      const hasCraftPlan = !!(this.rotation.recipe && this.rotation.productionPlan);
      const hasGatherTarget = !!(this.rotation.resource && this.rotation.resourceLoc);

      if (hasCraftPlan) {
        return this._executeCrafting(ctx);
      }
      if (hasGatherTarget) {
        if (this._canFulfillOrders()) {
          const craftClaim = await this._ensureOrderClaim(ctx, 'craft', { craftSkill: 'alchemy' });
          if (craftClaim) return this._executeCrafting(ctx);
        }
        return this._executeGathering(ctx);
      }

      log.warn(`[${ctx.name}] Rotation: alchemy state invalid (missing craft plan and gather target), rotating`);
      await this.rotation.forceRotate(ctx);
      return true;
    }

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
      await this._clearActiveOrderClaim(ctx, { reason: 'npc_task_mode' });
      return this._executeNpcTask(ctx);
    }
    if (skill === 'item_task') {
      await this._clearActiveOrderClaim(ctx, { reason: 'item_task_mode' });
      return this._executeItemTask(ctx);
    }

    // Unknown skill — force rotate
    await this.rotation.forceRotate(ctx);
    return true;
  }

  _canFulfillOrders() {
    return this.orderBoard.fulfillOrders === true;
  }

  _isClaimForSource(sourceType) {
    return !!(this._activeOrderClaim && this._activeOrderClaim.sourceType === sourceType);
  }

  _recordProgress(n = 1) {
    if (this._activeOrderClaim) return false;
    this.rotation.recordProgress(n);
    return true;
  }

  async _clearActiveOrderClaim(ctx, { reason = 'clear_claim' } = {}) {
    const active = this._activeOrderClaim;
    if (!active) return;

    this._activeOrderClaim = null;
    try {
      releaseClaim(active.orderId, { charName: ctx.name, reason });
    } catch (err) {
      log.warn(`[${ctx.name}] Order claim release failed (${active.orderId}): ${err?.message || String(err)}`);
    }
  }

  _resolveOrderById(orderId) {
    if (!orderId) return null;
    const snapshot = getOrderBoardSnapshot();
    return snapshot.orders.find(order => order.id === orderId) || null;
  }

  _syncActiveClaimFromBoard() {
    if (!this._activeOrderClaim) return null;

    const order = this._resolveOrderById(this._activeOrderClaim.orderId);
    if (!order || order.status === 'fulfilled') {
      this._activeOrderClaim = null;
      return null;
    }

    if (order.claim?.charName !== this._activeOrderClaim.charName) {
      this._activeOrderClaim = null;
      return null;
    }

    this._activeOrderClaim = {
      ...this._activeOrderClaim,
      itemCode: order.itemCode,
      sourceType: order.sourceType,
      sourceCode: order.sourceCode,
      gatherSkill: order.gatherSkill || null,
      craftSkill: order.craftSkill || null,
      sourceLevel: order.sourceLevel || 0,
      remainingQty: order.remainingQty,
      claim: order.claim,
    };

    return this._activeOrderClaim;
  }

  _claimOrderForChar(ctx, order) {
    if (!order) return null;
    const claimed = claimOrder(order.id, {
      charName: ctx.name,
      leaseMs: this.orderBoard.leaseMs,
    });
    if (!claimed) return null;

    const active = {
      orderId: claimed.id,
      charName: ctx.name,
      itemCode: claimed.itemCode,
      sourceType: claimed.sourceType,
      sourceCode: claimed.sourceCode,
      gatherSkill: claimed.gatherSkill || null,
      craftSkill: claimed.craftSkill || null,
      sourceLevel: claimed.sourceLevel || 0,
      remainingQty: claimed.remainingQty,
      claim: claimed.claim,
    };
    this._activeOrderClaim = active;
    log.info(`[${ctx.name}] Order claim: ${claimed.itemCode} via ${claimed.sourceType}:${claimed.sourceCode} (remaining ${claimed.remainingQty})`);
    return active;
  }

  async _acquireGatherOrderClaim(ctx) {
    const orders = sortOrdersForClaim(listClaimableOrders({
      sourceType: 'gather',
      gatherSkill: this.rotation.currentSkill,
      charName: ctx.name,
    }));

    for (const order of orders) {
      const active = this._claimOrderForChar(ctx, order);
      if (active) return active;
    }
    return null;
  }

  async _acquireCombatOrderClaim(ctx) {
    const orders = sortOrdersForClaim(listClaimableOrders({
      sourceType: 'fight',
      charName: ctx.name,
    }));

    for (const order of orders) {
      const sim = await this._simulateClaimFight(ctx, order.sourceCode);
      if (!sim || !sim.simResult?.win || sim.simResult.hpLostPercent > 90) continue;

      const active = this._claimOrderForChar(ctx, order);
      if (active) return active;
    }
    return null;
  }

  _simulateClaimFight(ctx, monsterCode) {
    return optimizeForMonster(ctx, monsterCode);
  }

  _getCraftClaimItem(order) {
    return gameData.getItem(order?.itemCode || order?.sourceCode);
  }

  _resolveCraftClaimPlan(craft) {
    return gameData.resolveRecipeChain(craft);
  }

  _canFulfillCraftClaimPlan(plan, ctx) {
    return gameData.canFulfillPlan(plan, ctx);
  }

  _nowMs() {
    return Date.now();
  }

  _isTaskRewardCode(itemCode) {
    return gameData.isTaskReward(itemCode);
  }

  async _getCraftClaimBankItems(forceRefresh = false) {
    return gameData.getBankItems(forceRefresh);
  }

  async _getBankItemsForExchange(forceRefresh = false) {
    return gameData.getBankItems(forceRefresh);
  }

  _parseMissingBankDependency(reason = '') {
    const prefix = 'missing_bank_dependency:';
    if (!reason.startsWith(prefix)) return '';
    return reason.slice(prefix.length).trim();
  }

  _blockUnclaimableOrderForChar(order, ctx, reason = 'cannot_complete') {
    try {
      markCharBlocked(order.id, {
        charName: ctx.name,
        blockedRetryMs: this.orderBoard.blockedRetryMs,
      });
      log.info(`[${ctx.name}] Order claim skipped (${reason}): ${order.itemCode} via ${order.sourceType}:${order.sourceCode}`);
    } catch (err) {
      log.warn(`[${ctx.name}] Could not block unclaimable order ${order?.id || 'unknown'}: ${err?.message || String(err)}`);
    }
  }

  async _canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache) {
    const item = this._getCraftClaimItem(order);
    if (!item?.craft?.skill) {
      return { ok: false, reason: 'invalid_craft_order' };
    }
    if (item.craft.skill !== craftSkill) {
      return { ok: false, reason: 'wrong_craft_skill' };
    }
    if (item.craft.level > ctx.skillLevel(craftSkill)) {
      return { ok: false, reason: 'insufficient_craft_level' };
    }

    const plan = this._resolveCraftClaimPlan(item.craft);
    if (!plan || plan.length === 0) {
      return { ok: false, reason: 'unresolvable_recipe_chain' };
    }

    if (!this._canFulfillCraftClaimPlan(plan, ctx)) {
      return { ok: false, reason: 'insufficient_gather_skill' };
    }

    const bankItems = bank instanceof Map ? bank : new Map();

    for (const step of plan) {
      if (step.type !== 'bank') continue;
      const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
      if (have < step.quantity) {
        return { ok: false, reason: `missing_bank_dependency:${step.itemCode}` };
      }
    }

    for (const step of plan) {
      if (step.type !== 'fight') continue;

      const monsterCode = step.monster?.code;
      if (!monsterCode) {
        return { ok: false, reason: `invalid_fight_step:${step.itemCode || 'unknown'}` };
      }

      const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
      if (have >= step.quantity) continue;

      if (!simCache.has(monsterCode)) {
        simCache.set(monsterCode, await this._simulateClaimFight(ctx, monsterCode));
      }

      const sim = simCache.get(monsterCode);
      const simResult = sim?.simResult;
      if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
        return { ok: false, reason: `combat_not_viable:${monsterCode}` };
      }
    }

    return { ok: true, reason: '' };
  }

  async _acquireCraftOrderClaim(ctx, craftSkill) {
    const orders = sortOrdersForClaim(listClaimableOrders({
      sourceType: 'craft',
      craftSkill,
      charName: ctx.name,
    }));
    let bank = await this._getCraftClaimBankItems();
    const simCache = new Map();

    for (const order of orders) {
      let viability = await this._canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache);
      if (!viability.ok) {
        const missingCode = this._parseMissingBankDependency(viability.reason);
        if (missingCode && this._isTaskRewardCode(missingCode)) {
          const proactive = await this._maybeRunProactiveExchange(ctx, {
            extraNeedItemCode: missingCode,
            trigger: 'craft_claim',
          });
          if (proactive.attempted || proactive.resolved) {
            bank = await this._getCraftClaimBankItems(true);
            viability = await this._canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache);
          }
        }
      }
      if (!viability.ok) {
        this._blockUnclaimableOrderForChar(order, ctx, viability.reason);
        continue;
      }

      const active = this._claimOrderForChar(ctx, order);
      if (active) return active;
    }

    return null;
  }

  async _ensureOrderClaim(ctx, sourceType, opts = {}) {
    if (!this._canFulfillOrders()) return null;
    const craftSkill = opts.craftSkill ? `${opts.craftSkill}`.trim() : '';

    const active = this._syncActiveClaimFromBoard();
    if (active && active.sourceType !== sourceType) {
      await this._clearActiveOrderClaim(ctx, { reason: 'source_type_changed' });
      return null;
    }
    if (active && sourceType === 'craft' && craftSkill && active.craftSkill && active.craftSkill !== craftSkill) {
      await this._clearActiveOrderClaim(ctx, { reason: 'craft_skill_changed' });
      return null;
    }

    if (active) {
      const renewed = renewClaim(active.orderId, {
        charName: ctx.name,
        leaseMs: this.orderBoard.leaseMs,
      });
      if (!renewed) {
        this._activeOrderClaim = null;
        return null;
      }
      return this._syncActiveClaimFromBoard();
    }

    if (sourceType === 'gather') {
      return this._acquireGatherOrderClaim(ctx);
    }
    if (sourceType === 'fight') {
      return this._acquireCombatOrderClaim(ctx);
    }
    if (sourceType === 'craft' && craftSkill) {
      return this._acquireCraftOrderClaim(ctx, craftSkill);
    }
    return null;
  }

  async _depositClaimItemsIfNeeded(ctx, { force = false } = {}) {
    const claim = this._syncActiveClaimFromBoard();
    if (!claim) return false;

    const carried = ctx.itemCount(claim.itemCode);
    if (carried <= 0) return false;

    const shouldDeposit = force || carried >= claim.remainingQty || ctx.inventoryFull();
    if (!shouldDeposit) return false;

    await depositBankItems(ctx, [{ code: claim.itemCode, quantity: carried }], {
      reason: `order claim ${claim.orderId}`,
    });
    const fresh = this._syncActiveClaimFromBoard();
    if (!fresh) {
      log.info(`[${ctx.name}] Order fulfilled: ${claim.itemCode}`);
    } else {
      log.info(`[${ctx.name}] Order progress: ${fresh.itemCode} remaining ${fresh.remainingQty}`);
    }
    return true;
  }

  async _blockAndReleaseClaim(ctx, reason = 'blocked') {
    const claim = this._syncActiveClaimFromBoard();
    if (!claim) return;

    try {
      markCharBlocked(claim.orderId, {
        charName: ctx.name,
        blockedRetryMs: this.orderBoard.blockedRetryMs,
      });
      log.info(`[${ctx.name}] Order claim blocked (${reason}): ${claim.itemCode} via ${claim.sourceCode}`);
    } catch (err) {
      log.warn(`[${ctx.name}] Could not block claim ${claim.orderId}: ${err?.message || String(err)}`);
    } finally {
      this._activeOrderClaim = null;
    }
  }

  // --- Gathering (mining, woodcutting, fishing) ---

  async _executeGathering(ctx) {
    let claim = await this._ensureOrderClaim(ctx, 'gather');

    let resource = this.rotation.resource;
    let loc = this.rotation.resourceLoc;
    if (claim) {
      resource = gameData.getResource(claim.sourceCode);
      loc = resource ? await gameData.getResourceLocation(resource.code) : null;
      if (!resource || !loc) {
        log.warn(`[${ctx.name}] Order claim invalid for gather ${claim.sourceCode}; releasing claim`);
        await this._clearActiveOrderClaim(ctx, { reason: 'missing_gather_source' });
        claim = null;
        resource = this.rotation.resource;
        loc = this.rotation.resourceLoc;
      }
    }

    if (!loc) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Safety: verify we can actually gather this resource
    if (resource && resource.level > ctx.skillLevel(resource.skill)) {
      if (claim) {
        await this._blockAndReleaseClaim(ctx, 'insufficient_skill');
        return true;
      }
      log.warn(`[${ctx.name}] ${resource.code}: skill too low (need ${resource.skill} lv${resource.level}, have lv${ctx.skillLevel(resource.skill)}), rotating`);
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Smelt/process raw materials before gathering more (skip while fulfilling orders)
    if (!claim) {
      const smelted = await this._trySmelting(ctx);
      if (smelted) return !ctx.inventoryFull();
    }

    // Equip optimal gathering gear (tool + prospecting)
    await equipForGathering(ctx, resource?.skill || this.rotation.currentSkill);

    await moveTo(ctx, loc.x, loc.y);
    const result = await gatherOnce(ctx);

    const items = result.details?.items || [];
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
    const progressed = this._recordProgress(totalQty);

    if (progressed) {
      const res = this.rotation.resource;
      log.info(`[${ctx.name}] ${res.code}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
    } else {
      const active = this._syncActiveClaimFromBoard();
      const remaining = active ? active.remainingQty : 0;
      log.info(`[${ctx.name}] Order gather ${resource.code}: ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (remaining ${remaining})`);
      await this._depositClaimItemsIfNeeded(ctx);
    }

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
    let claim = await this._ensureOrderClaim(ctx, 'fight');

    let monsterCode = this.rotation.monster?.code || null;
    let loc = this.rotation.monsterLoc;

    if (claim) {
      monsterCode = claim.sourceCode;
      loc = await gameData.getMonsterLocation(monsterCode);
      if (!loc) {
        log.warn(`[${ctx.name}] Order claim invalid for monster ${monsterCode}; blocking claim`);
        await this._blockAndReleaseClaim(ctx, 'missing_monster_location');
        claim = null;
        monsterCode = this.rotation.monster?.code || null;
        loc = this.rotation.monsterLoc;
      }
    }

    if (!monsterCode || !loc) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Optimize gear for target monster (cached — only runs once per target)
    const { ready = true } = await equipForCombat(ctx, monsterCode);
    if (!ready) {
      const context = claim ? 'order fight' : 'combat';
      log.warn(`[${ctx.name}] ${context}: combat gear not ready for ${monsterCode}, deferring`);
      return false;
    }
    await prepareCombatPotions(ctx, monsterCode);

    // Withdraw food from bank for all remaining fights (once per combat goal)
    if (!claim && !this._foodWithdrawn) {
      const remaining = this.rotation.goalTarget - this.rotation.goalProgress;
      await withdrawFoodForFights(ctx, monsterCode, remaining);
      this._foodWithdrawn = true;
    }

    await moveTo(ctx, loc.x, loc.y);
    if (!(await restBeforeFight(ctx, monsterCode))) {
      const context = claim ? 'order fight' : 'combat';
      log.warn(`[${ctx.name}] ${context}: can't rest before fighting ${monsterCode}, attempting fight anyway`);
    }

    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monsterCode);

      if (this._recordProgress(1)) {
        log.info(`[${ctx.name}] ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
      } else {
        const active = this._syncActiveClaimFromBoard();
        const remaining = active ? active.remainingQty : 0;
        log.info(`[${ctx.name}] Order fight ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (remaining ${remaining})`);
        await this._depositClaimItemsIfNeeded(ctx);
      }

      return !ctx.inventoryFull();
    }

    ctx.recordLoss(monsterCode);
    const losses = ctx.consecutiveLosses(monsterCode);
    log.warn(`[${ctx.name}] ${monsterCode}: LOSS ${r.turns}t (${losses} losses)`);

    if (this._isClaimForSource('fight') && losses >= this.maxLosses) {
      await this._blockAndReleaseClaim(ctx, 'combat_losses');
      return true;
    }

    if (losses >= this.maxLosses) {
      log.info(`[${ctx.name}] Too many losses, rotating to different skill`);
      await this.rotation.forceRotate(ctx);
    }
    return true;
  }

  // --- Crafting ---

  async _executeCrafting(ctx) {
    const craftSkill = this.rotation.currentSkill;
    const claim = await this._ensureOrderClaim(ctx, 'craft', { craftSkill });

    let recipe = this.rotation.recipe;
    let plan = this.rotation.productionPlan;
    let claimMode = false;
    let claimGoal = 0;

    if (claim) {
      const claimItem = gameData.getItem(claim.itemCode || claim.sourceCode);
      if (!claimItem?.craft?.skill) {
        await this._blockAndReleaseClaim(ctx, 'invalid_craft_order');
        return true;
      }
      if (claimItem.craft.skill !== craftSkill) {
        await this._blockAndReleaseClaim(ctx, 'wrong_craft_skill');
        return true;
      }
      if (ctx.skillLevel(craftSkill) < claimItem.craft.level) {
        await this._blockAndReleaseClaim(ctx, 'insufficient_craft_level');
        return true;
      }

      const claimPlan = gameData.resolveRecipeChain(claimItem.craft);
      if (!claimPlan) {
        await this._blockAndReleaseClaim(ctx, 'unresolvable_recipe_chain');
        return true;
      }

      recipe = claimItem;
      plan = claimPlan;
      claimMode = true;
      claimGoal = Math.max(1, Number(claim.remainingQty) || 1);
    }

    if (!plan || !recipe) {
      await this.rotation.forceRotate(ctx);
      return true;
    }

    // Work on a local copy so claim-mode planning doesn't mutate rotation state.
    plan = [...plan];

    // Append final craft step if not already in the plan.
    if (plan.length === 0 || plan[plan.length - 1].itemCode !== recipe.code) {
      plan.push({ type: 'craft', itemCode: recipe.code, recipe: recipe.craft, quantity: 1 });
    }

    // Re-withdraw if bank routine deposited our materials
    if (this.rotation.bankChecked && ctx.inventoryCount() === 0) {
      this.rotation.bankChecked = false;
    }

    // Withdraw matching ingredients from bank (scaled for batch)
    if (!this.rotation.bankChecked) {
      this.rotation.bankChecked = true;
      this._currentBatch = claimMode ? 1 : this._batchSize(ctx);
      await this._withdrawFromBank(ctx, plan, recipe.code, this._currentBatch);
    }

    // Walk through production plan steps
    let reserveGatherBlocked = false;
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];

      if (step.type === 'bank') {
        // Must come from bank (event items, etc.) — already withdrawn above
        const have = ctx.itemCount(step.itemCode);
        if (have >= step.quantity) continue; // have enough for at least 1 craft
        if (this._isTaskRewardCode(step.itemCode)) {
          const proactive = await this._maybeRunProactiveExchange(ctx, {
            extraNeedItemCode: step.itemCode,
            trigger: claimMode ? 'craft_step_claim' : 'craft_step',
          });
          if (proactive.resolved) {
            // Rewards are deposited to bank; force a fresh withdraw pass next tick.
            this.rotation.bankChecked = false;
            return true;
          }
        }
        if (claimMode) {
          await this._blockAndReleaseClaim(ctx, 'missing_bank_dependency');
        } else {
          log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: need ${step.quantity}x ${step.itemCode} from bank, have ${have} — skipping recipe`);
          await this.rotation.forceRotate(ctx);
        }
        return true;
      }

      if (step.type === 'gather') {
        // Check if we already have enough (accounting for batch + intermediates)
        const needed = rawMaterialNeeded(ctx, plan, step.itemCode, this._currentBatch);
        if (ctx.itemCount(step.itemCode) >= needed) continue;

        const usableSpace = this._usableInventorySpace(ctx);
        if (usableSpace <= 0) {
          const reserve = this._inventoryReserve(ctx);
          log.info(
            `[${ctx.name}] ${this.rotation.currentSkill}: gather paused for ${step.itemCode}; ` +
            `inventory reserve reached (${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve})`,
          );
          reserveGatherBlocked = true;
          continue;
        }

        // Gather one batch from the resource
        const loc = await gameData.getResourceLocation(step.resource.code);
        if (!loc) {
          if (claimMode) {
            await this._blockAndReleaseClaim(ctx, 'missing_gather_location');
          } else {
            log.warn(`[${ctx.name}] Cannot find location for ${step.resource.code}, skipping recipe`);
            await this.rotation.forceRotate(ctx);
          }
          return true;
        }

        // Equip gathering gear for this resource's skill (e.g. alchemy gloves)
        await equipForGathering(ctx, step.resource.skill);

        await moveTo(ctx, loc.x, loc.y);
        const result = await gatherOnce(ctx);
        const items = result.details?.items || [];
        log.info(`[${ctx.name}] ${this.rotation.currentSkill}: gathering ${step.itemCode} for ${recipe.code} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);
        return !ctx.inventoryFull();
      }

      if (step.type === 'fight') {
        // Check if we already have enough from bank withdrawal or prior fights
        const needed = step.quantity * this._currentBatch;
        if (ctx.itemCount(step.itemCode) >= needed) continue;

        // Find monster location
        const monsterCode = step.monster.code;
        const monsterLoc = step.monsterLoc || await gameData.getMonsterLocation(monsterCode);
        if (!monsterLoc) {
          if (claimMode) {
            await this._blockAndReleaseClaim(ctx, 'missing_fight_location');
          } else {
            log.warn(`[${ctx.name}] Cannot find location for monster ${monsterCode}, skipping recipe`);
            await this.rotation.forceRotate(ctx);
          }
          return true;
        }

        // Equip for combat against this monster
        const { simResult, ready = true } = await this._equipForCraftFight(ctx, monsterCode);
        if (!ready) {
          log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: combat gear not ready for ${monsterCode}, deferring recipe step`);
          return false;
        }
        if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
          await this._handleUnwinnableCraftFight(ctx, {
            monsterCode,
            itemCode: step.itemCode,
            recipeCode: recipe.code,
            claimMode,
            simResult,
          });
          return true;
        }

        await prepareCombatPotions(ctx, monsterCode);

        // Try to rest first, but don't skip crafting if rest is unavailable.
        // Dedicated crafters may still need to attempt low-HP fights for drops.
        if (!(await restBeforeFight(ctx, monsterCode))) {
          log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: can't rest before fighting ${monsterCode} for ${step.itemCode}, attempting fight anyway`);
        }

        await moveTo(ctx, monsterLoc.x, monsterLoc.y);
        const result = await fightOnce(ctx);
        const r = parseFightResult(result, ctx);

        if (r.win) {
          ctx.clearLosses(monsterCode);
          log.info(`[${ctx.name}] ${this.rotation.currentSkill}: farming ${step.itemCode} from ${monsterCode} for ${recipe.code} — WIN ${r.turns}t${r.drops ? ' | ' + r.drops : ''} (have ${ctx.itemCount(step.itemCode)}/${needed})`);
        } else {
          ctx.recordLoss(monsterCode);
          const losses = ctx.consecutiveLosses(monsterCode);
          log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: farming ${monsterCode} for ${step.itemCode} — LOSS (${losses} losses)`);
          if (losses >= this.maxLosses) {
            if (claimMode) {
              await this._blockAndReleaseClaim(ctx, 'combat_losses');
            } else {
              log.info(`[${ctx.name}] Too many losses farming ${monsterCode}, rotating`);
              await this.rotation.forceRotate(ctx);
            }
          }
        }
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
          // Final step: craft as many as materials allow, up to remaining goal/claim.
          const finalGoal = claimMode
            ? claimGoal
            : Math.max(0, this.rotation.goalTarget - this.rotation.goalProgress);
          craftQty = Math.min(
            finalGoal,
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
          const progressed = this._recordProgress(craftQty);
          if (progressed) {
            log.info(`[${ctx.name}] ${this.rotation.currentSkill}: ${recipe.code} x${craftQty} complete (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
          } else {
            await this._depositClaimItemsIfNeeded(ctx, { force: true });
            const active = this._syncActiveClaimFromBoard();
            if (active) {
              log.info(`[${ctx.name}] Craft order progress: ${active.itemCode} remaining ${active.remainingQty}`);
            } else {
              log.info(`[${ctx.name}] Craft order fulfilled: ${recipe.code}`);
            }
          }

          // Allow re-withdrawal from bank for next batch
          this.rotation.bankChecked = false;
          this._currentBatch = 1;

        }
        return true;
      }
    }

    if (reserveGatherBlocked) {
      log.info(`[${ctx.name}] ${this.rotation.currentSkill}: reserve pressure blocked gathering; yielding to allow bank/deposit routines`);
      return false;
    }

    // If we get here, couldn't make progress — try next iteration
    // (bank deposit may have freed inventory, or we already have materials)
    return !ctx.inventoryFull();
  }

  _equipForCraftFight(ctx, monsterCode) {
    return equipForCombat(ctx, monsterCode);
  }

  async _handleUnwinnableCraftFight(ctx, { monsterCode, itemCode, recipeCode, claimMode, simResult } = {}) {
    const hpLost = Number.isFinite(simResult?.hpLostPercent)
      ? `${Math.round(simResult.hpLostPercent)}%`
      : 'n/a';
    const simOutcome = simResult?.win ? 'win' : 'loss';

    log.warn(`[${ctx.name}] ${this.rotation.currentSkill}: skipping ${recipeCode || 'recipe'} fight step ${monsterCode} -> ${itemCode || 'drop'} (sim ${simOutcome}, hpLost ${hpLost})`);

    if (claimMode) {
      await this._blockAndReleaseClaim(ctx, 'combat_not_viable');
      return true;
    }

    this.rotation.blockCurrentRecipe({
      reason: `combat not viable vs ${monsterCode}`,
      ctx,
    });
    await this.rotation.forceRotate(ctx);
    return true;
  }

  _inventoryReserve(ctx) {
    const capacity = Math.max(0, Number(ctx.inventoryCapacity()) || 0);
    if (capacity <= 1) return 0;

    const percentReserve = Math.ceil(capacity * RESERVE_PCT);
    const reserve = Math.max(RESERVE_MIN, percentReserve);
    return Math.min(RESERVE_MAX, reserve, capacity - 1);
  }

  _usableInventorySpace(ctx) {
    const capacity = Math.max(0, Number(ctx.inventoryCapacity()) || 0);
    const used = Math.max(0, Number(ctx.inventoryCount()) || 0);
    const reserve = this._inventoryReserve(ctx);
    return Math.max(0, capacity - used - reserve);
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
      if (step.type === 'bank' || step.type === 'gather' || step.type === 'fight') {
        materialsPerCraft += step.quantity;
      }
    }
    if (materialsPerCraft === 0) materialsPerCraft = 1;

    // Cap by reserve-aware inventory space
    const space = this._usableInventorySpace(ctx);
    const spaceLimit = Math.floor(space / materialsPerCraft);

    return Math.max(1, Math.min(remaining, spaceLimit));
  }

  // --- Bank withdrawal for crafting ---

  async _withdrawFromBank(ctx, plan, finalRecipeCode, batchSize = 1) {
    if (!plan) return;

    const maxUnits = this._usableInventorySpace(ctx);
    if (maxUnits <= 0) {
      log.info(`[${ctx.name}] Rotation crafting: skipping bank withdrawal (inventory reserve reached)`);
      return;
    }

    const excludeCodes = finalRecipeCode ? [finalRecipeCode] : [];
    const withdrawn = await withdrawPlanFromBank(ctx, plan, batchSize, { excludeCodes, maxUnits });
    if (withdrawn.length > 0) {
      log.info(`[${ctx.name}] Rotation crafting: withdrew from bank: ${withdrawn.join(', ')}`);
    }
  }

  // --- NPC Tasks ---

  async _executeNpcTask(ctx) {
    return this._executeTaskByType(ctx, 'monsters');
  }

  async _executeItemTask(ctx) {
    return this._executeTaskByType(ctx, 'items');
  }

  async _executeTaskByType(ctx, preferredType) {
    if (!ctx.hasTask()) {
      if (preferredType === 'monsters') return this._runNpcTaskFlow(ctx);
      return this._runItemTaskFlow(ctx);
    }

    const c = ctx.get();
    let activeType = c.task_type;

    if (activeType !== 'monsters' && activeType !== 'items') {
      activeType = this._inferTaskType(c.task);
      if (activeType) {
        log.warn(`[${ctx.name}] Rotation: task_type "${c.task_type || 'missing'}" for ${c.task}, inferred ${activeType}`);
      }
    }

    if (!activeType) {
      log.warn(`[${ctx.name}] Rotation: unknown task_type "${c.task_type || 'missing'}" for ${c.task}, force-rotating`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    if (activeType !== preferredType) {
      const selectedSkill = preferredType === 'monsters' ? 'npc_task' : 'item_task';
      const existingType = activeType === 'monsters' ? 'monster' : 'item';
      log.info(`[${ctx.name}] Rotation: ${selectedSkill} selected, continuing existing ${existingType} task (${c.task} ${c.task_progress}/${c.task_total})`);
    }

    if (activeType === 'monsters') return this._runNpcTaskFlow(ctx);
    return this._runItemTaskFlow(ctx);
  }

  _inferTaskType(taskCode) {
    const isMonsterTask = !!gameData.getMonster(taskCode);
    const isItemTask = !!gameData.getItem(taskCode);
    if (isMonsterTask && !isItemTask) return 'monsters';
    if (isItemTask && !isMonsterTask) return 'items';
    return null;
  }

  async _runNpcTaskFlow(ctx) {
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
    const { simResult, ready = true } = await equipForCombat(ctx, monster);
    if (!ready) {
      log.warn(`[${ctx.name}] NPC Task: combat gear not ready for ${monster}, deferring`);
      return false;
    }
    if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
      log.warn(`[${ctx.name}] NPC Task: simulation predicts loss vs ${monster} even with optimal gear, skipping`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }
    await prepareCombatPotions(ctx, monster);

    // Withdraw food from bank for all remaining task fights (once per NPC task)
    if (!this._foodWithdrawn) {
      const remaining = c.task_total - c.task_progress;
      await withdrawFoodForFights(ctx, monster, remaining);
      this._foodWithdrawn = true;
    }

    await moveTo(ctx, monsterLoc.x, monsterLoc.y);
    if (!(await restBeforeFight(ctx, monster))) {
      log.warn(`[${ctx.name}] NPC Task: can't rest before fighting ${monster}, attempting fight anyway`);
    }

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

  // --- Item Tasks ---

  async _runItemTaskFlow(ctx) {
    const ITEMS_MASTER = TASKS_MASTER.items;

    // 1. Accept a task if we don't have one
    if (!ctx.hasTask()) {
      await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
      const result = await api.acceptTask(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      const c = ctx.get();
      log.info(`[${ctx.name}] Item Task: accepted ${c.task} x${c.task_total}`);
    }

    // 2. Complete task if done
    if (ctx.taskComplete()) {
      await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
      const result = await api.completeTask(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      this.rotation.recordProgress(1);
      log.info(`[${ctx.name}] Item Task: completed! (${this.rotation.goalProgress}/${this.rotation.goalTarget})`);
      await this._exchangeTaskCoins(ctx);
      return true;
    }

    const c = ctx.get();
    const itemCode = c.task;
    const needed = c.task_total - c.task_progress;

    // 3. Check prerequisites — can we obtain this item?
    const item = gameData.getItem(itemCode);
    if (!item) {
      log.warn(`[${ctx.name}] Item Task: unknown item ${itemCode}, cancelling`);
      await this._cancelItemTask(ctx, ITEMS_MASTER);
      return true;
    }

    // Check if it's a gatherable resource drop
    const resource = gameData.getResourceForDrop(itemCode);
    // Check if it's craftable
    const craftable = item.craft ? true : false;

    if (!resource && !craftable) {
      log.warn(`[${ctx.name}] Item Task: ${itemCode} can't be gathered or crafted, cancelling`);
      await this._cancelItemTask(ctx, ITEMS_MASTER);
      return true;
    }

    // Try to withdraw from bank and trade first (before gathering)
    const haveQty = ctx.itemCount(itemCode);
    if (!ctx.inventoryFull()) {
      const bankQty = await this._withdrawForItemTask(ctx, itemCode, needed - haveQty);
      const totalHave = ctx.itemCount(itemCode);
      if (totalHave > 0) {
        return this._tradeItemTask(ctx, itemCode, Math.min(totalHave, needed));
      }
    }

    // If we have items in inventory, trade them
    if (haveQty > 0) {
      return this._tradeItemTask(ctx, itemCode, Math.min(haveQty, needed));
    }

    // Prerequisite check for gathering
    if (resource) {
      const charLevel = ctx.skillLevel(resource.skill);
      if (charLevel < resource.level) {
        // Can we craft it instead?
        if (!craftable) {
          log.warn(`[${ctx.name}] Item Task: need ${resource.skill} lv${resource.level} for ${itemCode} (have lv${charLevel}), cancelling`);
          await this._cancelItemTask(ctx, ITEMS_MASTER);
          return true;
        }
        // Fall through to crafting path
      } else {
        // Gather path
        return this._gatherForItemTask(ctx, itemCode, resource, needed);
      }
    }

    // Crafting path
    if (craftable) {
      const plan = gameData.resolveRecipeChain(item.craft);
      if (!plan) {
        log.warn(`[${ctx.name}] Item Task: can't resolve recipe for ${itemCode}, cancelling`);
        await this._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
        return true;
      }

      // Check if character can execute all steps
      let canExecute = true;
      for (const step of plan) {
        if (step.type === 'gather' && step.resource) {
          if (ctx.skillLevel(step.resource.skill) < step.resource.level) {
            log.warn(`[${ctx.name}] Item Task: ${itemCode} needs ${step.resource.skill} lv${step.resource.level} (have lv${ctx.skillLevel(step.resource.skill)})`);
            canExecute = false;
            break;
          }
        }
        if (step.type === 'craft' && step.recipe) {
          if (ctx.skillLevel(step.recipe.skill) < step.recipe.level) {
            log.warn(`[${ctx.name}] Item Task: ${itemCode} needs ${step.recipe.skill} lv${step.recipe.level} for crafting (have lv${ctx.skillLevel(step.recipe.skill)})`);
            canExecute = false;
            break;
          }
        }
      }

      if (!canExecute) {
        await this._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
        return true;
      }

      // Check craft skill level for the final item itself
      if (ctx.skillLevel(item.craft.skill) < item.craft.level) {
        log.warn(`[${ctx.name}] Item Task: need ${item.craft.skill} lv${item.craft.level} to craft ${itemCode} (have lv${ctx.skillLevel(item.craft.skill)})`);
        await this._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
        return true;
      }

      return this._craftForItemTask(ctx, itemCode, item, plan, needed);
    }

    // Fallback gather
    if (resource) {
      return this._gatherForItemTask(ctx, itemCode, resource, needed);
    }

    // Can't obtain this item — place order and cancel
    log.warn(`[${ctx.name}] Item Task: no path to obtain ${itemCode}`);
    await this._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
    return true;
  }

  async _craftForItemTask(ctx, itemCode, item, plan, needed) {
    // How many of the final item do we need to craft?
    // Each craft produces item.craft.quantity units
    const craftYield = item.craft.quantity || 1;
    const haveItem = ctx.itemCount(itemCode);
    const roundsRemaining = Math.ceil((needed - haveItem) / craftYield);
    if (roundsRemaining <= 0) {
      // Already have enough — trade them
      return this._tradeItemTask(ctx, itemCode, Math.min(haveItem, needed));
    }

    let materialsPerRound = 0;
    for (const step of plan) {
      if (step.type !== 'craft') {
        materialsPerRound += Math.max(0, Number(step.quantity) || 0);
      }
    }
    if (materialsPerRound <= 0) materialsPerRound = 1;

    const usableSpace = this._usableInventorySpace(ctx);
    const spaceLimit = Math.floor(usableSpace / materialsPerRound);
    const batchRounds = Math.max(1, Math.min(roundsRemaining, spaceLimit));
    if (batchRounds < roundsRemaining) {
      log.info(
        `[${ctx.name}] Item Task craft: batching ${itemCode} to ${batchRounds}/${roundsRemaining} ` +
        `round(s) (usable space ${usableSpace}, mats/round ${materialsPerRound})`,
      );
    }

    // Process each step in the recipe chain
    for (const step of plan) {
      const stepNeeded = step.quantity * batchRounds;
      const stepHave = ctx.itemCount(step.itemCode);

      if (stepHave >= stepNeeded) continue; // already have enough

      const deficit = stepNeeded - stepHave;

      if (step.type === 'gather') {
        // Try bank first
        if (!ctx.inventoryFull()) {
          await this._withdrawForItemTask(ctx, step.itemCode, deficit, { maxQuantity: deficit });
          if (ctx.itemCount(step.itemCode) >= stepNeeded) continue;
        }

        const usableNow = this._usableInventorySpace(ctx);
        if (usableNow <= 0) {
          const reserve = this._inventoryReserve(ctx);
          log.info(
            `[${ctx.name}] Item Task craft: reserve pressure before gathering ${step.itemCode} ` +
            `(${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve}) — craft/trade fallback`,
          );
          const fallback = await this._craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed, {
            reason: `reserve pressure while gathering ${step.itemCode}`,
          });
          if (fallback.progressed) return true;
          log.info(`[${ctx.name}] Item Task craft: reserve pressure and no craft/trade progress, yielding`);
          return false;
        }

        // Gather the rest
        const loc = await gameData.getResourceLocation(step.resource.code);
        if (!loc) {
          log.warn(`[${ctx.name}] Item Task craft: can't find location for ${step.resource.code}`);
          return true;
        }

        await equipForGathering(ctx, step.resource.skill);
        await moveTo(ctx, loc.x, loc.y);
        const result = await gatherOnce(ctx);
        const items = result.details?.items || [];
        log.info(`[${ctx.name}] Item Task craft: gathering ${step.itemCode} for ${itemCode} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${ctx.itemCount(step.itemCode)}/${stepNeeded})`);
        // Return to let the loop call us again — we'll accumulate materials over multiple ticks
        return true;
      }

      if (step.type === 'craft') {
        // Check if we have the materials for this intermediate craft
        const craftItem = gameData.getItem(step.itemCode);
        if (!craftItem?.craft) continue;

        const canCraft = Math.min(
          ...craftItem.craft.items.map(mat =>
            Math.floor(ctx.itemCount(mat.code) / mat.quantity)
          )
        );
        if (canCraft <= 0) continue; // need to gather more, earlier steps will handle it

        const toCraft = Math.min(canCraft, Math.ceil(deficit / (craftItem.craft.quantity || 1)));
        const workshops = await gameData.getWorkshops();
        const ws = workshops[craftItem.craft.skill];
        if (!ws) {
          log.warn(`[${ctx.name}] Item Task craft: no workshop for ${craftItem.craft.skill}`);
          return true;
        }

        await moveTo(ctx, ws.x, ws.y);
        const result = await api.craft(step.itemCode, toCraft, ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();
        log.info(`[${ctx.name}] Item Task craft: crafted ${step.itemCode} x${toCraft} (${ctx.itemCount(step.itemCode)}/${stepNeeded})`);
        return true;
      }

      if (step.type === 'fight') {
        // Need to fight a monster for a drop — skip for now if we can't
        log.warn(`[${ctx.name}] Item Task craft: need ${step.itemCode} from ${step.monster?.code || 'unknown'} — fight drops not yet supported in item tasks`);
        return true;
      }
    }

    const finalPass = await this._craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed);
    if (finalPass.progressed) return true;

    // Shouldn't happen if steps above ran correctly, but safety check
    log.warn(`[${ctx.name}] Item Task craft: have all steps but can't craft ${itemCode}?`);
    return true;
  }

  async _craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed, opts = {}) {
    if (!item?.craft) return { progressed: false, crafted: false, traded: false };

    let crafted = false;
    let traded = false;
    const craftYield = item.craft.quantity || 1;
    const recipeItems = Array.isArray(item.craft.items) ? item.craft.items : [];

    if (recipeItems.length > 0) {
      const canCraftFinal = Math.min(
        ...recipeItems.map(mat =>
          Math.floor(ctx.itemCount(mat.code) / mat.quantity)
        )
      );

      if (canCraftFinal > 0) {
        const currentHave = ctx.itemCount(itemCode);
        const remainingNeeded = Math.max(0, needed - currentHave);
        let toCraft = canCraftFinal;
        if (remainingNeeded > 0) {
          toCraft = Math.min(toCraft, Math.ceil(remainingNeeded / craftYield));
        }

        if (toCraft > 0) {
          const workshops = await gameData.getWorkshops();
          const ws = workshops[item.craft.skill];
          if (!ws) {
            log.warn(`[${ctx.name}] Item Task craft: no workshop for ${item.craft.skill}`);
            return { progressed: false, crafted: false, traded: false };
          }

          await moveTo(ctx, ws.x, ws.y);
          const result = await api.craft(itemCode, toCraft, ctx.name);
          await api.waitForCooldown(result);
          await ctx.refresh();
          const produced = toCraft * craftYield;
          log.info(`[${ctx.name}] Item Task craft: crafted ${itemCode} x${produced}${opts.reason ? ` (${opts.reason})` : ''}`);
          crafted = true;
        }
      }
    }

    const tradeQty = Math.min(ctx.itemCount(itemCode), needed);
    if (tradeQty > 0) {
      if (opts.reason) {
        log.info(`[${ctx.name}] Item Task craft: ${opts.reason} — trading ${itemCode} x${tradeQty}`);
      }
      await this._tradeItemTask(ctx, itemCode, tradeQty);
      traded = true;
    }

    return {
      progressed: crafted || traded,
      crafted,
      traded,
    };
  }

  async _placeOrderAndCancel(ctx, itemCode, needed, masterLoc) {
    // Try to place an order on the orderboard
    const item = gameData.getItem(itemCode);
    const resource = gameData.getResourceForDrop(itemCode);

    if (resource) {
      this.rotation._enqueueOrder({
        sourceType: 'gather',
        sourceCode: resource.code,
        gatherSkill: resource.skill,
        sourceLevel: resource.level,
        itemCode,
        requesterName: ctx.name,
        quantity: needed,
      });
      log.info(`[${ctx.name}] Item Task: placed orderboard request for ${itemCode} x${needed} (gather ${resource.code})`);
    } else if (item?.craft) {
      // For crafted items, place order for the raw materials
      const plan = gameData.resolveRecipeChain(item.craft);
      if (plan) {
        for (const step of plan) {
          if (step.type === 'gather' && step.resource) {
            this.rotation._enqueueOrder({
              sourceType: 'gather',
              sourceCode: step.resource.code,
              gatherSkill: step.resource.skill,
              sourceLevel: step.resource.level,
              itemCode: step.itemCode,
              requesterName: ctx.name,
              recipeCode: itemCode,
              quantity: step.quantity * needed,
            });
            log.info(`[${ctx.name}] Item Task: placed orderboard request for ${step.itemCode} x${step.quantity * needed} (for ${itemCode})`);
          }
        }
      }
    }

    await this._cancelItemTask(ctx, masterLoc);
  }

  async _cancelItemTask(ctx, masterLoc) {
    if (ctx.taskCoins() < 1) {
      log.warn(`[${ctx.name}] Item Task: can't cancel (no task coins), force-rotating`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return;
    }
    await moveTo(ctx, masterLoc.x, masterLoc.y);
    const result = await api.cancelTask(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    log.info(`[${ctx.name}] Item Task: cancelled`);
  }

  async _withdrawForItemTask(ctx, itemCode, needed, opts = {}) {
    const neededQty = Math.max(0, Math.floor(Number(needed) || 0));
    if (neededQty <= 0) return 0;

    const bank = await gameData.getBankItems(true);
    const inBank = bank.get(itemCode) || 0;
    log.info(`[${ctx.name}] Item Task: bank check for ${itemCode} — ${inBank} in bank, need ${neededQty}`);
    if (inBank <= 0) return 0;

    const rawMaxQuantity = Number(opts.maxQuantity);
    const maxQuantity = Number.isFinite(rawMaxQuantity)
      ? Math.max(0, Math.floor(rawMaxQuantity))
      : Number.POSITIVE_INFINITY;
    const usableSpace = this._usableInventorySpace(ctx);
    const toWithdraw = Math.min(inBank, neededQty, usableSpace, maxQuantity);
    if (toWithdraw <= 0) {
      if (usableSpace <= 0) {
        const reserve = this._inventoryReserve(ctx);
        log.info(
          `[${ctx.name}] Item Task: withdrawal deferred for ${itemCode}; ` +
          `reserve reached (${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve})`,
        );
      }
      return 0;
    }

    try {
      const result = await withdrawBankItems(ctx, [{ code: itemCode, quantity: toWithdraw }], {
        reason: 'item task withdrawal',
        mode: 'partial',
        retryStaleOnce: true,
      });
      const row = result.withdrawn.find(entry => entry.code === itemCode);
      const withdrawn = row?.quantity || 0;
      if (withdrawn > 0) {
        log.info(`[${ctx.name}] Item Task: withdrew ${itemCode} x${withdrawn} from bank`);
      }
      return withdrawn;
    } catch (err) {
      log.warn(`[${ctx.name}] Item Task: bank withdraw failed for ${itemCode}: ${err.message}`);
      return 0;
    }
  }

  async _gatherForItemTask(ctx, itemCode, resource, needed) {
    const loc = await gameData.getResourceLocation(resource.code);
    if (!loc) {
      log.warn(`[${ctx.name}] Item Task: can't find location for ${resource.code}`);
      this.rotation.goalProgress = this.rotation.goalTarget;
      return true;
    }

    // Trade if we've accumulated a batch (20% of remaining, min 1)
    const haveQty = ctx.itemCount(itemCode);
    const batchTarget = Math.ceil(needed * 0.2);
    if (haveQty >= batchTarget || (haveQty > 0 && ctx.inventoryFull())) {
      return this._tradeItemTask(ctx, itemCode, Math.min(haveQty, needed));
    }

    // If inventory is full but no task items, can't continue
    if (ctx.inventoryFull()) return false;

    // Gather
    await equipForGathering(ctx, resource.skill);
    await moveTo(ctx, loc.x, loc.y);
    const result = await gatherOnce(ctx);
    const items = result.details?.items || [];
    log.info(`[${ctx.name}] Item Task: gathering ${itemCode} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${ctx.itemCount(itemCode)}/${batchTarget} for next trade)`);

    return !ctx.inventoryFull();
  }

  async _tradeItemTask(ctx, itemCode, quantity) {
    const ITEMS_MASTER = TASKS_MASTER.items;
    await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
    try {
      const result = await api.taskTrade(itemCode, quantity, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      const c = ctx.get();
      log.info(`[${ctx.name}] Item Task: traded ${itemCode} x${quantity} (${c.task_progress}/${c.task_total})`);
    } catch (err) {
      if (err.code === 478) {
        log.warn(`[${ctx.name}] Item Task: missing items for trade`);
      } else {
        throw err;
      }
    }
    return true;
  }

  // --- Task coin exchange ---

  _collectExchangeTargets({ extraNeedItemCode = '' } = {}) {
    const targets = typeof this.rotation?.getExchangeTargets === 'function'
      ? this.rotation.getExchangeTargets()
      : new Map();
    const code = `${extraNeedItemCode || ''}`.trim();
    if (code && this._isTaskRewardCode(code)) {
      targets.set(code, Math.max(targets.get(code) || 0, 1));
    }
    return targets;
  }

  _computeUnmetTargets(ctx, targets, bankItems) {
    const unmet = new Map();
    const bank = bankItems instanceof Map ? bankItems : new Map();

    for (const [code, rawTarget] of targets) {
      const target = Math.max(0, Math.floor(Number(rawTarget) || 0));
      if (!code || target <= 0) continue;
      const have = (bank.get(code) || 0) + ctx.itemCount(code);
      if (have < target) unmet.set(code, target - have);
    }
    return unmet;
  }

  _inventorySnapshotForTargets(ctx, targets) {
    const snapshot = new Map();
    for (const code of targets.keys()) {
      snapshot.set(code, ctx.itemCount(code));
    }
    return snapshot;
  }

  async _ensureExchangeCoinsInInventory(ctx, minCoins = TASK_EXCHANGE_COST) {
    const invCoins = ctx.itemCount(TASK_COIN_CODE);
    if (invCoins >= minCoins) {
      return { ok: true, available: invCoins };
    }

    const needed = Math.max(0, minCoins - invCoins);
    if (needed <= 0) {
      return { ok: true, available: invCoins };
    }

    const result = await withdrawBankItems(ctx, [{ code: TASK_COIN_CODE, quantity: needed }], {
      reason: 'task exchange coin withdrawal',
      mode: 'partial',
      retryStaleOnce: true,
    });
    for (const row of result.failed) {
      log.warn(`[${ctx.name}] Task Exchange: coin withdrawal failed for ${row.code}: ${row.error}`);
    }

    const refreshedInv = ctx.itemCount(TASK_COIN_CODE);
    const ok = refreshedInv >= minCoins;
    return { ok, available: refreshedInv };
  }

  async _depositTargetRewardsToBank(ctx, targets, beforeInvSnapshot = new Map()) {
    const deposits = [];
    for (const code of targets.keys()) {
      const before = beforeInvSnapshot.get(code) || 0;
      const now = ctx.itemCount(code);
      const gained = now - before;
      if (gained > 0) {
        deposits.push({ code, quantity: gained });
      }
    }
    if (deposits.length === 0) return [];

    try {
      return await depositBankItems(ctx, deposits, {
        reason: 'task exchange reward deposit',
      });
    } catch (err) {
      log.warn(`[${ctx.name}] Task Exchange: reward deposit failed: ${err.message}`);
      return [];
    }
  }

  async _performTaskExchange(ctx) {
    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.taskExchange(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
  }

  async _runTaskExchange(
    ctx,
    { targets = null, trigger = 'unknown', proactive = false, extraNeedItemCode = '' } = {},
  ) {
    let targetMap = targets instanceof Map
      ? new Map(targets)
      : this._collectExchangeTargets({ extraNeedItemCode });
    const extraCode = `${extraNeedItemCode || ''}`.trim();
    if (extraCode && this._isTaskRewardCode(extraCode)) {
      targetMap.set(extraCode, Math.max(targetMap.get(extraCode) || 0, 1));
    }
    if (targetMap.size === 0) {
      return { attempted: false, exchanged: 0, resolved: true, reason: 'no_targets' };
    }

    if (taskExchangeLockHolder && taskExchangeLockHolder !== ctx.name) {
      return { attempted: false, exchanged: 0, resolved: false, reason: 'lock_busy' };
    }

    taskExchangeLockHolder = ctx.name;
    try {
      let bank = await this._getBankItemsForExchange(true);
      let unmet = this._computeUnmetTargets(ctx, targetMap, bank);
      if (unmet.size === 0) {
        return { attempted: false, exchanged: 0, resolved: true, reason: 'targets_met' };
      }

      let attempted = false;
      let exchanged = 0;
      let reason = 'targets_unmet';

      while (unmet.size > 0) {
        const coinStatus = await this._ensureExchangeCoinsInInventory(ctx, TASK_EXCHANGE_COST);
        if (!coinStatus.ok) {
          reason = 'insufficient_coins';
          break;
        }

        if (ctx.inventoryCount() + 2 >= ctx.inventoryCapacity()) {
          reason = 'inventory_full';
          break;
        }

        attempted = true;
        const beforeInv = this._inventorySnapshotForTargets(ctx, targetMap);

        try {
          await this._performTaskExchange(ctx);
          exchanged += 1;
          log.info(`[${ctx.name}] Task Exchange (${trigger}): exchanged ${TASK_EXCHANGE_COST} coins (${ctx.taskCoins()} available)`);
        } catch (err) {
          reason = `exchange_failed:${err.code || 'unknown'}`;
          log.warn(`[${ctx.name}] Task Exchange (${trigger}) failed: ${err.message}`);
          break;
        }

        await this._depositTargetRewardsToBank(ctx, targetMap, beforeInv);
        bank = await this._getBankItemsForExchange(true);
        unmet = this._computeUnmetTargets(ctx, targetMap, bank);
      }

      const resolved = unmet.size === 0;
      if (resolved) {
        if (attempted) {
          log.info(`[${ctx.name}] Task Exchange (${trigger}): targets met`);
        }
        return { attempted, exchanged, resolved: true, reason: 'targets_met' };
      }

      if (!attempted && reason === 'targets_unmet') {
        reason = 'deferred';
      }
      if (proactive && reason === 'lock_busy') {
        return { attempted: false, exchanged, resolved: false, reason };
      }
      return { attempted, exchanged, resolved: false, reason };
    } finally {
      if (taskExchangeLockHolder === ctx.name) {
        taskExchangeLockHolder = null;
      }
    }
  }

  async _maybeRunProactiveExchange(ctx, { extraNeedItemCode = '', trigger = 'proactive' } = {}) {
    const now = this._nowMs();
    if (now < this._nextProactiveExchangeAt) {
      return { attempted: false, exchanged: 0, resolved: false, reason: 'backoff' };
    }

    const targets = this._collectExchangeTargets({ extraNeedItemCode });
    if (targets.size === 0) {
      return { attempted: false, exchanged: 0, resolved: true, reason: 'no_targets' };
    }

    const result = await this._runTaskExchange(ctx, {
      targets,
      trigger,
      proactive: true,
      extraNeedItemCode,
    });
    if (!result.resolved) {
      this._nextProactiveExchangeAt = this._nowMs() + PROACTIVE_EXCHANGE_BACKOFF_MS;
    } else {
      this._nextProactiveExchangeAt = 0;
    }
    return result;
  }

  async _exchangeTaskCoins(ctx) {
    const targets = this._collectExchangeTargets();
    if (targets.size === 0) return;
    await this._runTaskExchange(ctx, {
      targets,
      trigger: 'task_completion',
      proactive: false,
    });
  }
}
