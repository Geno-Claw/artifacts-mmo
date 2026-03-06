/**
 * Order Fulfillment Routine — dedicated order board worker.
 *
 * Prioritizes direct gather/fight/npc_buy claims first, then craft claims,
 * then task_exchange claims. Falls back to craft prerequisite expansion
 * when no directly completable craft order exists.
 */
import * as log from '../log.mjs';
import { getOrderBoardSnapshot, listClaimableOrders } from '../services/order-board.mjs';
import { SkillRotationRoutine } from './skill-rotation/index.mjs';
import {
  acquireCraftOrderClaimAnySkill,
  acquireGatherOrderClaimAnySkill,
} from './skill-rotation/order-claims.mjs';

const TAG = 'Order Fulfillment';
const fulfillmentLog = log.createLogger({ scope: 'routine.order-fulfillment' });
const DEFAULT_PRIORITY = 8;
const DEFAULT_CRAFT_SCAN_LIMIT = 1;
const DEFAULT_MAX_LOSSES = 2;
const NO_CLAIM_BACKOFF_MS = 120_000; // 2 min backoff when no orders can be fulfilled
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
    this._noClaimBackoffUntil = 0;
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

    // Active claim or adoptable claim — always run.
    if (this._syncActiveClaimFromBoard()) return true;
    if (this._findAdoptableClaim(ctx)) return true;

    // If we recently failed to claim anything, back off so lower-priority
    // routines get a chance to run instead of spinning.
    if (this._noClaimBackoffUntil > Date.now()) return false;

    return listClaimableOrders({ charName: ctx.name }).length > 0;
  }

  canBePreempted(_ctx) {
    return true;
  }

  async execute(ctx) {
    const logger = log.forCharacter(fulfillmentLog, ctx);
    let claim = this._syncActiveClaimFromBoard();
    if (!claim) {
      claim = this._adoptClaimForCharacter(ctx);
    }

    if (!claim) {
      claim = await this._claimNextByPriority(ctx);
    }
    if (!claim) {
      this._lastClaimOrderId = null;
      // Set backoff so we fall through to lower-priority routines
      // instead of spinning on unfulfillable orders.
      this._noClaimBackoffUntil = Date.now() + NO_CLAIM_BACKOFF_MS;
      logger.info(`[${ctx.name}] ${TAG}: no claimable orders — backing off ${NO_CLAIM_BACKOFF_MS / 1000}s`, {
        event: 'order_fulfillment.backoff',
        reasonCode: 'yield_for_backoff',
        data: {
          backoffMs: NO_CLAIM_BACKOFF_MS,
        },
      });
      return this._yield('yield_for_backoff', {
        reason: 'no_claimable_orders',
        backoffMs: NO_CLAIM_BACKOFF_MS,
      });
    }

    // Successfully claimed — clear any backoff.
    this._noClaimBackoffUntil = 0;

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
    if (claim.sourceType === 'npc_buy') {
      const result = await this._fulfillNpcBuyOrderClaim(ctx);
      return result.attempted || result.fulfilled;
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
      try {
        const result = await this._fulfillTaskExchangeOrderClaim(ctx);
        return result.attempted || result.fulfilled;
      } catch (err) {
        // 496 = "Condition not met" — e.g. missing tasks_farmer achievement.
        // Block the claim so we stop retrying and move on.
        if (err.status === 496 || err.code === 496 || `${err.code}` === '496') {
          logger.warn(`[${ctx.name}] ${TAG}: task_exchange claim blocked (condition not met): ${err.message}`, {
            event: 'order_fulfillment.claim.blocked',
            reasonCode: 'routine_conditions_changed',
            error: err,
            data: {
              sourceType: claim.sourceType,
              sourceCode: claim.sourceCode,
              itemCode: claim.itemCode,
              orderId: claim.orderId,
            },
          });
          await this._blockAndReleaseClaim(ctx, 'condition_not_met');
          this._noClaimBackoffUntil = Date.now() + NO_CLAIM_BACKOFF_MS;
          return true;
        }
        throw err;
      }
    }

    logger.warn(`[${ctx.name}] ${TAG}: unsupported claim source ${claim.sourceType}; blocking`, {
      event: 'order_fulfillment.claim.unsupported_source',
      reasonCode: 'routine_conditions_changed',
      data: {
        orderId: claim.orderId,
        itemCode: claim.itemCode,
        sourceType: claim.sourceType,
        sourceCode: claim.sourceCode,
      },
    });
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

    const npcBuy = await this._acquireNpcBuyOrderClaim(ctx);
    if (npcBuy) return npcBuy;

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

  async _acquireNpcBuyOrderClaim(ctx) {
    return super._acquireNpcBuyOrderClaim(ctx);
  }

  async _acquireCraftOrderClaimAnySkill(ctx, opts = {}) {
    return acquireCraftOrderClaimAnySkill(ctx, this, opts);
  }
}
