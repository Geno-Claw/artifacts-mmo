/**
 * Order Fulfillment Routine — dedicated order board worker.
 *
 * Prioritizes direct gather/fight claims first, then craft claims, then
 * task_exchange claims. Falls back to craft prerequisite expansion when
 * no directly completable craft order exists.
 */
import * as log from '../log.mjs';
import { getOrderBoardSnapshot, listClaimableOrders } from '../services/order-board.mjs';
import { SkillRotationRoutine } from './skill-rotation/index.mjs';
import {
  acquireCraftOrderClaimAnySkill,
  acquireGatherOrderClaimAnySkill,
} from './skill-rotation/order-claims.mjs';

const TAG = 'Order Fulfillment';
const DEFAULT_PRIORITY = 8;
const DEFAULT_CRAFT_SCAN_LIMIT = 1;
const DEFAULT_MAX_LOSSES = 2;
const DEFAULT_ORDER_BOARD = Object.freeze({
  enabled: true,
  createOrders: true,
  fulfillOrders: true,
  leaseMs: 120_000,
  blockedRetryMs: 600_000,
});

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export class OrderFulfillmentRoutine extends SkillRotationRoutine {
  constructor({
    priority = DEFAULT_PRIORITY,
    enabled = true,
    maxLosses = DEFAULT_MAX_LOSSES,
    craftScanLimit = DEFAULT_CRAFT_SCAN_LIMIT,
    orderBoard = DEFAULT_ORDER_BOARD,
    type = 'orderFulfillment',
  } = {}) {
    super({
      priority,
      maxLosses,
      orderBoard,
      type,
    });
    this.name = TAG;
    this.configType = type;
    this.enabled = enabled === true;
    this.craftScanLimit = toPositiveInt(craftScanLimit, DEFAULT_CRAFT_SCAN_LIMIT);
    this._lastClaimOrderId = null;
  }

  updateConfig({ enabled, maxLosses, craftScanLimit, orderBoard } = {}) {
    if (enabled !== undefined) this.enabled = enabled === true;
    if (craftScanLimit !== undefined) {
      this.craftScanLimit = toPositiveInt(craftScanLimit, DEFAULT_CRAFT_SCAN_LIMIT);
    }

    const patch = {};
    if (maxLosses !== undefined) patch.maxLosses = maxLosses;
    if (orderBoard !== undefined) patch.orderBoard = orderBoard;
    if (Object.keys(patch).length > 0) {
      super.updateConfig(patch);
    }
  }

  canRun(ctx) {
    if (!this.enabled) return false;
    if (!this._canFulfillOrders()) return false;
    if (ctx.inventoryFull()) return false;

    if (this._syncActiveClaimFromBoard()) return true;
    if (this._findAdoptableClaim(ctx)) return true;
    return listClaimableOrders({ charName: ctx.name }).length > 0;
  }

  canBePreempted(_ctx) {
    return true;
  }

  async execute(ctx) {
    let claim = this._syncActiveClaimFromBoard();
    if (!claim) {
      claim = this._adoptClaimForCharacter(ctx);
    }

    if (!claim) {
      claim = await this._claimNextByPriority(ctx);
    }
    if (!claim) {
      this._lastClaimOrderId = null;
      return false;
    }

    if (this._lastClaimOrderId !== claim.orderId) {
      this._lastClaimOrderId = claim.orderId;
      this.rotation.bankChecked = false;
      this._foodWithdrawn = false;
    }

    if (claim.sourceType === 'gather') {
      this.rotation.currentSkill = `${claim.gatherSkill || ''}`.trim() || this.rotation.currentSkill;
      return this._executeGathering(ctx);
    }
    if (claim.sourceType === 'fight') {
      this.rotation.currentSkill = 'combat';
      return this._executeCombat(ctx);
    }
    if (claim.sourceType === 'craft') {
      const craftSkill = `${claim.craftSkill || ''}`.trim();
      if (!craftSkill) {
        await this._blockAndReleaseClaim(ctx, 'missing_craft_skill');
        return true;
      }
      this.rotation.currentSkill = craftSkill;
      return this._executeCrafting(ctx);
    }
    if (claim.sourceType === 'task_exchange') {
      const result = await this._fulfillTaskExchangeOrderClaim(ctx);
      return result.attempted || result.fulfilled;
    }

    log.warn(`[${ctx.name}] ${TAG}: unsupported claim source ${claim.sourceType}; blocking`);
    await this._blockAndReleaseClaim(ctx, 'unsupported_claim_source');
    return true;
  }

  _findAdoptableClaim(ctx) {
    const snapshot = getOrderBoardSnapshot();
    for (const order of snapshot.orders) {
      if (order?.status !== 'claimed') continue;
      if (!order?.claim || order.claim.charName !== ctx.name) continue;
      if ((Number(order.remainingQty) || 0) <= 0) continue;
      return order;
    }
    return null;
  }

  _adoptClaimForCharacter(ctx) {
    const adoptable = this._findAdoptableClaim(ctx);
    if (!adoptable) return null;
    return this._claimOrderForChar(ctx, adoptable);
  }

  async _claimNextByPriority(ctx) {
    const gather = await this._acquireGatherOrderClaimAnySkill(ctx);
    if (gather) return gather;

    const fight = await this._acquireCombatOrderClaim(ctx);
    if (fight) return fight;

    const craft = await this._acquireCraftOrderClaimAnySkill(ctx, {
      expandLimit: this.craftScanLimit,
      directFirst: true,
    });
    if (craft) return craft;

    const exchange = await this._acquireTaskExchangeOrderClaim(ctx);
    if (exchange) return exchange;

    return null;
  }

  async _acquireGatherOrderClaimAnySkill(ctx) {
    return acquireGatherOrderClaimAnySkill(ctx, this);
  }

  async _acquireCraftOrderClaimAnySkill(ctx, opts = {}) {
    return acquireCraftOrderClaimAnySkill(ctx, this, opts);
  }
}
