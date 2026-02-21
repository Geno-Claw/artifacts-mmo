/**
 * Automatic bank expansion purchasing.
 * Buys a 20-slot expansion whenever the next expansion is affordable
 * (cost <= maxGoldPct of total gold).
 *
 * Module-level shared state coordinates across all character instances
 * so only one character purchases at a time.
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { ensureAtBank } from '../services/bank-travel.mjs';
import { withdrawGoldFromBank } from '../services/bank-ops.mjs';

// Shared across all BankExpansionRoutine instances (one per character).
let _purchasing = false;
let _bankDetails = null;
let _detailsFetchedAt = 0;

export class BankExpansionRoutine extends BaseRoutine {
  constructor({
    priority = 55,
    checkIntervalMs = 300_000,
    maxGoldPct = 0.7,
    goldBuffer = 0,
  } = {}) {
    super({ name: 'Bank Expansion', priority, loop: false });
    this.checkIntervalMs = checkIntervalMs;
    this.maxGoldPct = maxGoldPct;
    this.goldBuffer = goldBuffer;
  }

  canRun(ctx) {
    if (_purchasing) return false;

    const now = Date.now();
    if (!_bankDetails || (now - _detailsFetchedAt) >= this.checkIntervalMs) {
      // Cache expired or missing — let execute() fetch fresh data and decide.
      return true;
    }

    // Use cached details for a quick synchronous affordability check.
    const cost = _bankDetails.next_expansion_cost;
    const totalGold = ctx.get().gold + (_bankDetails.gold || 0);
    return cost <= totalGold * this.maxGoldPct && totalGold - cost >= this.goldBuffer;
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

    const cost = details.next_expansion_cost;
    const charGold = ctx.get().gold;
    const bankGold = details.gold || 0;
    const totalGold = charGold + bankGold;

    log.info(`[${ctx.name}] Bank expansion check: next expansion ${cost}g, total gold ${totalGold}g (${charGold}g char, ${bankGold}g bank)`);

    if (cost > totalGold * this.maxGoldPct) {
      log.info(`[${ctx.name}] Expansion too expensive: ${cost}g is >${Math.round(this.maxGoldPct * 100)}% of ${totalGold}g total`);
      return;
    }

    if (totalGold - cost < this.goldBuffer) {
      log.info(`[${ctx.name}] Expansion would leave ${totalGold - cost}g, need ${this.goldBuffer}g buffer`);
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
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);

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

export function _setBankDetails(details) {
  _bankDetails = details;
  _detailsFetchedAt = details ? Date.now() : 0;
}
