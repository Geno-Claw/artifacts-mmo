/**
 * Automatic bank expansion purchasing.
 * Checks bank capacity via GET /my/bank; when free slots drop below threshold
 * and enough gold is available, purchases a 20-slot expansion.
 *
 * Module-level shared state coordinates across all character instances
 * so only one character purchases at a time.
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { ensureAtBank } from '../services/bank-travel.mjs';
import { withdrawGoldFromBank } from '../services/bank-ops.mjs';
import { getBankItems } from '../services/inventory-manager.mjs';

// Shared across all BankExpansionRoutine instances (one per character).
let _purchasing = false;
let _bankDetails = null;
let _detailsFetchedAt = 0;

export class BankExpansionRoutine extends BaseRoutine {
  constructor({
    priority = 45,
    slotThreshold = 5,
    checkIntervalMs = 300_000,
    maxGoldPct = 0.7,
  } = {}) {
    super({ name: 'Bank Expansion', priority, loop: false });
    this.slotThreshold = slotThreshold;
    this.checkIntervalMs = checkIntervalMs;
    this.maxGoldPct = maxGoldPct;
  }

  canRun(ctx) {
    if (_purchasing) return false;

    const now = Date.now();
    const cacheValid = _bankDetails && (now - _detailsFetchedAt) < this.checkIntervalMs;

    if (!cacheValid) {
      // Cache expired or missing — let execute() fetch fresh data and decide.
      return true;
    }

    // Use cached details for a quick synchronous check.
    const bankItems = getBankItems();
    // getBankItems returns a Map synchronously from cache (or a Promise if
    // cache is stale). If it's a Promise, let execute() handle it.
    if (bankItems instanceof Promise) return true;

    const usedSlots = bankItems.size;
    const freeSlots = _bankDetails.slots - usedSlots;
    if (freeSlots > this.slotThreshold) return false;

    const cost = _bankDetails.next_expansion_cost;
    const totalGold = ctx.get().gold + (_bankDetails.gold || 0);
    if (totalGold < cost) return false;
    if (cost > totalGold * this.maxGoldPct) return false;

    return true;
  }

  async execute(ctx) {
    _purchasing = true;
    try {
      await this._doExecute(ctx);
    } finally {
      _purchasing = false;
    }
  }

  async _doExecute(ctx) {
    // Fetch fresh bank details.
    const details = await api.getBankDetails();
    _bankDetails = details;
    _detailsFetchedAt = Date.now();

    // Compute free slots using inventory-manager's bank item map.
    const bankItems = await getBankItems();
    const usedSlots = bankItems.size;
    const freeSlots = details.slots - usedSlots;
    const cost = details.next_expansion_cost;

    log.info(`[${ctx.name}] Bank expansion check: ${usedSlots}/${details.slots} slots used (${freeSlots} free), next expansion ${cost}g`);

    if (freeSlots > this.slotThreshold) {
      log.info(`[${ctx.name}] Bank has ${freeSlots} free slots (threshold: ${this.slotThreshold}), skipping`);
      return;
    }

    const charGold = ctx.get().gold;
    const bankGold = details.gold || 0;
    const totalGold = charGold + bankGold;

    if (totalGold < cost) {
      log.info(`[${ctx.name}] Not enough gold for expansion: need ${cost}g, have ${totalGold}g (${charGold}g char, ${bankGold}g bank)`);
      return;
    }

    if (cost > totalGold * this.maxGoldPct) {
      log.info(`[${ctx.name}] Expansion too expensive: ${cost}g is >${Math.round(this.maxGoldPct * 100)}% of ${totalGold}g total`);
      return;
    }

    // Move to bank.
    await ensureAtBank(ctx);

    // Withdraw gold from bank if character doesn't have enough on hand.
    if (charGold < cost) {
      const needed = cost - charGold;
      log.info(`[${ctx.name}] Withdrawing ${needed}g from bank for expansion`);
      await withdrawGoldFromBank(ctx, needed);
    }

    // Purchase expansion.
    log.info(`[${ctx.name}] Purchasing bank expansion (+20 slots) for ${cost}g`);
    try {
      const result = await api.buyBankExpansion(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();

      // Clear cache so next check sees updated slots/cost.
      _bankDetails = null;
      _detailsFetchedAt = 0;

      log.info(`[${ctx.name}] Bank expansion purchased! New capacity: ${details.slots + 20} slots`);
    } catch (err) {
      if (err.code === 492) {
        log.warn(`[${ctx.name}] Bank expansion failed: insufficient gold`);
      } else if (err.code === 598) {
        log.warn(`[${ctx.name}] Bank expansion failed: not at bank`);
      } else {
        throw err;
      }
    }
  }
}

// Test helpers.
export function _resetForTests() {
  _purchasing = false;
  _bankDetails = null;
  _detailsFetchedAt = 0;
}

export function _getSharedState() {
  return { purchasing: _purchasing, bankDetails: _bankDetails, detailsFetchedAt: _detailsFetchedAt };
}

export function _setPurchasing(val) {
  _purchasing = val;
}
