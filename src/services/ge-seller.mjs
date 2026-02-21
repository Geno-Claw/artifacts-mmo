/**
 * Grand Exchange selling service.
 * Handles sell-candidate analysis, pricing, order management,
 * and the full sell flow (withdraw → GE → list → re-deposit).
 */
import { readFileSync } from 'fs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import {
  withdrawBankItems,
  withdrawGoldFromBank,
} from './bank-ops.mjs';
import { moveTo } from '../helpers.mjs';

let sellRules = null;

// --- Concurrency control ---

let _sellLock = null;

async function withSellLock(fn) {
  while (_sellLock) await _sellLock;
  let release;
  _sellLock = new Promise(r => { release = r; });
  try {
    return await fn();
  } finally {
    _sellLock = null;
    release();
  }
}

// --- Config ---

export function loadSellRules() {
  try {
    sellRules = JSON.parse(readFileSync('./config/sell-rules.json', 'utf-8'));
    log.info(`[GE] Sell rules loaded — duplicateEquip: ${sellRules.sellDuplicateEquipment}, alwaysSell: ${sellRules.alwaysSell?.length || 0} items, neverSell: ${sellRules.neverSell?.length || 0} items`);
  } catch (err) {
    log.warn(`[GE] Could not load sell-rules.json: ${err.message} — GE selling disabled`);
    sellRules = null;
  }
}

export function getSellRules() {
  return sellRules;
}

// --- Analysis ---

/**
 * Determine which items to sell from bank contents.
 * Only considers bank quantities — items on characters are in use and not
 * part of the sell decision. Rings auto-double the keep value (2 slots per char).
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems - code → quantity
 * @returns {Array<{ code: string, quantity: number, reason: string }>}
 */
export function analyzeSellCandidates(ctx, bankItems) {
  if (!sellRules) return [];

  const candidates = [];
  const neverSellSet = new Set(sellRules.neverSell || []);

  // Equipment duplicates are handled by recycler — GE is whitelist-only (alwaysSell)

  // Always-sell list
  for (const rule of (sellRules.alwaysSell || [])) {
    if (neverSellSet.has(rule.code)) continue;
    if (candidates.some(c => c.code === rule.code)) continue;

    const bankQty = bankItems.get(rule.code) || 0;
    const keepInBank = rule.keepInBank || 0;
    const surplus = bankQty - keepInBank;
    if (surplus <= 0) continue;

    candidates.push({
      code: rule.code,
      quantity: surplus,
      reason: `always-sell rule (keeping ${keepInBank})`,
    });
  }

  return candidates;
}

// --- Pricing ---

/**
 * Determine a sell price for an item on the GE.
 * Queries current listings and undercuts, or falls back to level-based pricing.
 */
export async function determinePrice(code) {
  const minPrice = sellRules?.minPrice || 1;

  try {
    const result = await api.getAllGEOrders({ code, type: 'sell', size: 100 });
    const listings = Array.isArray(result) ? result : [];

    if (listings.length > 0) {
      const lowestPrice = Math.min(...listings.map(o => o.price));
      const undercutPct = (sellRules?.undercutPercent || 5) / 100;
      const targetPrice = Math.floor(lowestPrice * (1 - undercutPct));
      return Math.max(targetPrice, minPrice);
    }
  } catch (err) {
    log.warn(`[GE] Could not fetch listings for ${code}: ${err.message}`);
  }

  // Fallback: price based on item level
  const item = gameData.getItem(code);
  const level = item?.level || 1;
  return Math.max(level * 10, minPrice);
}

// --- Order management ---

/**
 * Check for completed GE orders and log results.
 * Gold from completed sales is auto-credited to the character.
 */
export async function collectCompletedOrders(ctx) {
  try {
    const result = await api.getMyGEOrders({ size: 100 });
    const orders = Array.isArray(result) ? result : [];

    if (orders.length > 0) {
      log.info(`[${ctx.name}] GE: ${orders.length} active order(s)`);
    }

    return orders;
  } catch (err) {
    log.warn(`[${ctx.name}] GE: could not fetch orders: ${err.message}`);
    return [];
  }
}

/**
 * Cancel stale orders older than the configured threshold.
 * Returns the number of orders cancelled.
 */
export async function cancelStaleOrders(ctx, activeOrders) {
  const hours = sellRules?.cancelStaleAfterHours || 0;
  if (hours <= 0) return 0;

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  let cancelled = 0;

  for (const order of activeOrders) {
    const createdAt = new Date(order.created_at).getTime();
    if (createdAt >= cutoff) continue;

    try {
      log.info(`[${ctx.name}] GE: cancelling stale order ${order.id} (${order.code} x${order.quantity})`);
      const result = await api.cancelGE(order.id, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
      cancelled++;
    } catch (err) {
      log.warn(`[${ctx.name}] GE: could not cancel order ${order.id}: ${err.message}`);
    }
  }

  if (cancelled > 0) {
    log.info(`[${ctx.name}] GE: cancelled ${cancelled} stale order(s)`);
  }
  return cancelled;
}

// --- Main sell flow ---

/**
 * Execute the full GE sell flow for a character.
 * Assumes character is at the bank. Will move to GE and back.
 * Uses an async mutex so only one character sells at a time,
 * preventing concurrent reads of stale bank state.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @returns {Promise<number>} Number of new sell orders created
 */
export async function executeSellFlow(ctx) {
  if (_sellLock) {
    log.info(`[${ctx.name}] GE: waiting for another character's sell flow to finish`);
  }

  return withSellLock(async () => {
    const geLocation = gameData.getGELocation();
    if (!geLocation) {
      log.warn(`[${ctx.name}] GE: location unknown, skipping sell flow`);
      return 0;
    }

    // Force-refresh bank inside the lock to get current state
    const bankItems = await gameData.getBankItems(true);

    const candidates = analyzeSellCandidates(ctx, bankItems);
    if (candidates.length === 0) {
      log.info(`[${ctx.name}] GE: no items to sell`);
      return 0;
    }

    log.info(`[${ctx.name}] GE: ${candidates.length} item(s) to sell: ${candidates.map(c => `${c.code} x${c.quantity} (${c.reason})`).join(', ')}`);

    // Step 1: Withdraw sell candidates from bank (must be at bank)
    const withdrawResult = await withdrawBankItems(
      ctx,
      candidates.map(c => ({ code: c.code, quantity: c.quantity })),
      {
        reason: 'GE sell flow withdrawal',
        mode: 'partial',
        retryStaleOnce: true,
      },
    );
    const withdrawn = withdrawResult.withdrawn;
    for (const row of withdrawResult.failed) {
      log.warn(`[${ctx.name}] GE: could not withdraw ${row.code}: ${row.error}`);
    }
    for (const row of withdrawResult.skipped) {
      if (!row.reason.startsWith('partial fill')) {
        log.warn(`[${ctx.name}] GE: skipped ${row.code} (${row.reason})`);
      }
    }

    if (withdrawn.length === 0) return 0;

    // Step 2: Determine prices and ensure we have gold for listing fees (still at bank)
    const priced = [];
    for (const item of withdrawn) {
      const price = await determinePrice(item.code);
      priced.push({ ...item, price });
    }

    const totalFees = priced.reduce((sum, p) => sum + Math.ceil(p.price * p.quantity * 0.05), 0);
    const charGold = ctx.get().gold;
    if (totalFees > charGold) {
      const needed = totalFees - charGold;
      try {
        log.info(`[${ctx.name}] GE: withdrawing ${needed}g from bank for listing fees`);
        await withdrawGoldFromBank(ctx, needed, { reason: 'GE listing fees withdrawal' });
      } catch (err) {
        log.warn(`[${ctx.name}] GE: could not withdraw gold for fees: ${err.message}`);
      }
    }

    // Step 3: Move to GE
    await moveTo(ctx, geLocation.x, geLocation.y);

    // Step 4: Log active orders + stale cancellation
    const activeOrders = await collectCompletedOrders(ctx);
    await cancelStaleOrders(ctx, activeOrders);

    // Step 5: Create sell orders
    let ordersCreated = 0;

    for (const item of priced) {
      // Safety net: verify we actually have the items before listing
      const actualQty = ctx.itemCount(item.code);
      if (actualQty < item.quantity) {
        log.warn(`[${ctx.name}] GE: ${item.code} — inventory has ${actualQty}, expected ${item.quantity}, adjusting`);
        item.quantity = actualQty;
      }
      if (item.quantity <= 0) continue;

      try {
        const result = await api.sellGE(item.code, item.quantity, item.price, ctx.name);
        ctx.applyActionResult(result);
        await api.waitForCooldown(result);
        ordersCreated++;
        log.info(`[${ctx.name}] GE: listed ${item.code} x${item.quantity} @ ${item.price}g each`);
      } catch (err) {
        if (err.code === 437) {
          log.info(`[${ctx.name}] GE: ${item.code} cannot be sold on GE, will re-deposit`);
        } else if (err.code === 433) {
          log.warn(`[${ctx.name}] GE: order limit reached (100), stopping`);
          break;
        } else {
          log.warn(`[${ctx.name}] GE: failed to sell ${item.code}: ${err.message}`);
        }
      }
    }

    return ordersCreated;
  });
}
