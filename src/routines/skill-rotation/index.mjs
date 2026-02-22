/**
 * Skill Rotation Routine — randomly cycles between gathering, crafting,
 * combat, and NPC tasks with goal-based durations.
 *
 * Runs as a low-priority loop routine. Background routines (rest, bank)
 * interrupt via higher priority in the scheduler.
 *
 * Implementation is split across focused executor modules:
 *   gathering.mjs   — mining, woodcutting, fishing, smelting
 *   combat.mjs      — monster fighting
 *   crafting.mjs    — multi-step recipe crafting, batch management, inventory helpers
 *   npc-tasks.mjs   — NPC task accept/fight/complete flow
 *   item-tasks.mjs  — item task accept/gather/craft/trade flow
 *   task-exchange.mjs — proactive task coin exchange
 *   order-claims.mjs — order board claim lifecycle
 */
import { BaseRoutine } from '../base.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { SkillRotation } from '../../services/skill-rotation.mjs';
import { MAX_LOSSES_DEFAULT } from '../../data/locations.mjs';
import { optimizeForMonster } from '../../services/gear-optimizer.mjs';
import { GATHERING_SKILLS, CRAFTING_SKILLS } from './constants.mjs';

// Executor imports
import { executeGathering, trySmelting } from './gathering.mjs';
import { executeCombat } from './combat.mjs';
import { executeCrafting, equipForCraftFight, handleUnwinnableCraftFight, inventoryReserve, usableInventorySpace, batchSize, withdrawFromBank } from './crafting.mjs';
import { executeNpcTask, executeItemTask, executeTaskByType, inferTaskType, runNpcTaskFlow } from './npc-tasks.mjs';
import { runItemTaskFlow, craftForItemTask, craftAndTradeItemTaskFromInventory, placeOrderAndCancel, cancelItemTask, withdrawForItemTask, shouldTradeItemTaskNow, gatherForItemTask, tradeItemTask } from './item-tasks.mjs';
import { runTaskExchange, maybeRunProactiveExchange, exchangeTaskCoins, collectExchangeTargets, computeUnmetTargets, ensureExchangeCoinsInInventory, depositTargetRewardsToBank, performTaskExchange, inventorySnapshotForTargets } from './task-exchange.mjs';
import { ensureOrderClaim, acquireGatherOrderClaim, acquireCombatOrderClaim, acquireCraftOrderClaim, canClaimCraftOrderNow, depositClaimItemsIfNeeded, clearActiveOrderClaim, blockAndReleaseClaim, syncActiveClaimFromBoard, claimOrderForChar, blockUnclaimableOrderForChar, resolveOrderById, enqueueGatherOrderForDeficit, enqueueFightOrderForDeficit } from './order-claims.mjs';
import { executeAchievement } from './achievements.mjs';

const DEFAULT_ORDER_BOARD = Object.freeze({
  enabled: false,
  createOrders: false,
  fulfillOrders: false,
  leaseMs: 300_000,
  blockedRetryMs: 600_000,
});

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
    super({ name: 'Skill Rotation', priority, loop: true, type: rotationCfg.type });
    this.rotation = new SkillRotation({ ...rotationCfg, orderBoard });
    this.maxLosses = maxLosses;
    this.orderBoard = normalizeOrderBoardConfig(orderBoard);
    this._currentBatch = 1;
    this._foodWithdrawn = false;
    this._activeOrderClaim = null;
    this._nextProactiveExchangeAt = 0;
  }

  updateConfig({ maxLosses, orderBoard, ...rotationCfg } = {}) {
    if (maxLosses !== undefined) this.maxLosses = maxLosses;
    if (orderBoard !== undefined) this.orderBoard = normalizeOrderBoardConfig(orderBoard);
    this.rotation.updateConfig({ ...rotationCfg, orderBoard });
  }

  // --- Core routine interface ---

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
    if (skill === 'achievement') {
      return this._executeAchievement(ctx);
    }

    // Unknown skill — force rotate
    await this.rotation.forceRotate(ctx);
    return true;
  }

  // --- Small helpers (stay on class) ---

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

  _nowMs() {
    return Date.now();
  }

  _getCraftClaimItem(order) {
    return gameData.getItem(order?.itemCode || order?.sourceCode);
  }

  _resolveRecipeChain(craft) {
    return gameData.resolveRecipeChain(craft);
  }

  _canFulfillCraftClaimPlan(plan, ctx) {
    return gameData.canFulfillPlan(plan, ctx);
  }

  _canFulfillCraftClaimPlanWithBank(plan, ctx, bankItems) {
    return gameData.canFulfillPlanWithBank(plan, ctx, bankItems);
  }

  _isTaskRewardCode(itemCode) {
    return gameData.isTaskReward(itemCode);
  }

  _getItemTaskItem(itemCode) {
    return gameData.getItem(itemCode);
  }

  _getItemTaskResource(itemCode) {
    return gameData.getResourceForDrop(itemCode);
  }

  async _getBankItems(forceRefresh = false) {
    return gameData.getBankItems(forceRefresh);
  }

  _parseMissingBankDependency(reason = '') {
    const prefix = 'missing_bank_dependency:';
    if (!reason.startsWith(prefix)) return '';
    return reason.slice(prefix.length).trim();
  }

  _simulateClaimFight(ctx, monsterCode) {
    return optimizeForMonster(ctx, monsterCode);
  }

  // --- Gathering ---
  async _executeGathering(ctx) { return executeGathering(ctx, this); }
  async _trySmelting(ctx) { return trySmelting(ctx, this); }

  // --- Combat ---
  async _executeCombat(ctx) { return executeCombat(ctx, this); }

  // --- Crafting ---
  async _executeCrafting(ctx) { return executeCrafting(ctx, this); }
  _equipForCraftFight(ctx, monsterCode) { return equipForCraftFight(ctx, monsterCode); }
  async _handleUnwinnableCraftFight(ctx, opts) { return handleUnwinnableCraftFight(ctx, this, opts); }
  _inventoryReserve(ctx) { return inventoryReserve(ctx); }
  _usableInventorySpace(ctx) { return usableInventorySpace(ctx); }
  _batchSize(ctx) { return batchSize(ctx, this); }
  async _withdrawFromBank(ctx, plan, finalRecipeCode, batchSizeVal) { return withdrawFromBank(ctx, this, plan, finalRecipeCode, batchSizeVal); }

  // --- NPC Tasks ---
  async _executeNpcTask(ctx) { return executeNpcTask(ctx, this); }
  async _executeItemTask(ctx) { return executeItemTask(ctx, this); }
  async _executeTaskByType(ctx, preferredType) { return executeTaskByType(ctx, this, preferredType); }
  _inferTaskType(taskCode) { return inferTaskType(taskCode); }
  async _runNpcTaskFlow(ctx) { return runNpcTaskFlow(ctx, this); }

  // --- Item Tasks ---
  async _runItemTaskFlow(ctx) { return runItemTaskFlow(ctx, this); }
  async _craftForItemTask(ctx, itemCode, item, plan, needed) { return craftForItemTask(ctx, this, itemCode, item, plan, needed); }
  async _craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed, opts) { return craftAndTradeItemTaskFromInventory(ctx, this, itemCode, item, needed, opts); }
  async _placeOrderAndCancel(ctx, itemCode, needed, masterLoc) { return placeOrderAndCancel(ctx, this, itemCode, needed, masterLoc); }
  async _cancelItemTask(ctx, masterLoc) { return cancelItemTask(ctx, this, masterLoc); }
  async _withdrawForItemTask(ctx, itemCode, needed, opts) { return withdrawForItemTask(ctx, this, itemCode, needed, opts); }
  _shouldTradeItemTaskNow(ctx, opts) { return shouldTradeItemTaskNow(ctx, opts); }
  async _gatherForItemTask(ctx, itemCode, resource, needed) { return gatherForItemTask(ctx, this, itemCode, resource, needed); }
  async _tradeItemTask(ctx, itemCode, quantity) {
    const before = ctx.get().task_progress;
    const result = await tradeItemTask(ctx, itemCode, quantity);
    const after = ctx.get().task_progress;
    const delta = after - before;
    if (delta > 0) {
      this.rotation.recordProgress(delta);
    }
    return result;
  }

  // --- Achievement Hunter ---
  async _executeAchievement(ctx) { return executeAchievement(ctx, this); }

  // --- Task Exchange ---
  _collectExchangeTargets(opts) { return collectExchangeTargets(this, opts); }
  _computeUnmetTargets(ctx, targets, bankItems) { return computeUnmetTargets(ctx, targets, bankItems); }
  _inventorySnapshotForTargets(ctx, targets) { return inventorySnapshotForTargets(ctx, targets); }
  async _ensureExchangeCoinsInInventory(ctx, minCoins) { return ensureExchangeCoinsInInventory(ctx, minCoins); }
  async _depositTargetRewardsToBank(ctx, targets, beforeInvSnapshot) { return depositTargetRewardsToBank(ctx, targets, beforeInvSnapshot); }
  async _performTaskExchange(ctx) { return performTaskExchange(ctx); }
  async _runTaskExchange(ctx, opts) { return runTaskExchange(ctx, this, opts); }
  async _maybeRunProactiveExchange(ctx, opts) { return maybeRunProactiveExchange(ctx, this, opts); }
  async _exchangeTaskCoins(ctx) { return exchangeTaskCoins(ctx, this); }

  // --- Order Claims ---
  async _clearActiveOrderClaim(ctx, opts) { return clearActiveOrderClaim(ctx, this, opts); }
  _resolveOrderById(orderId) { return resolveOrderById(this, orderId); }
  _syncActiveClaimFromBoard() { return syncActiveClaimFromBoard(this); }
  _claimOrderForChar(ctx, order) { return claimOrderForChar(ctx, this, order); }
  async _acquireGatherOrderClaim(ctx) { return acquireGatherOrderClaim(ctx, this); }
  async _acquireCombatOrderClaim(ctx) { return acquireCombatOrderClaim(ctx, this); }
  _blockUnclaimableOrderForChar(order, ctx, reason) { return blockUnclaimableOrderForChar(this, order, ctx, reason); }
  async _canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache) { return canClaimCraftOrderNow(ctx, this, order, craftSkill, bank, simCache); }
  async _acquireCraftOrderClaim(ctx, craftSkill) { return acquireCraftOrderClaim(ctx, this, craftSkill); }
  async _ensureOrderClaim(ctx, sourceType, opts) { return ensureOrderClaim(ctx, this, sourceType, opts); }
  async _depositClaimItemsIfNeeded(ctx, opts) { return depositClaimItemsIfNeeded(ctx, this, opts); }
  async _blockAndReleaseClaim(ctx, reason) { return blockAndReleaseClaim(ctx, this, reason); }
  _enqueueGatherOrderForDeficit(step, order, ctx, deficit) { return enqueueGatherOrderForDeficit(this, step, order, ctx, deficit); }
  _enqueueFightOrderForDeficit(step, order, ctx, deficit) { return enqueueFightOrderForDeficit(this, step, order, ctx, deficit); }
}
