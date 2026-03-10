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
import { analyzeSurplusEquipmentCandidates } from './equipment-surplus.mjs';
import { getItemsHeldForNpcSale } from './npc-seller.mjs';

const geLog = log.createLogger({ scope: 'service.ge-seller' });

let sellRules = null;
let _deps = {
  getAllGEOrdersFn: (params) => api.getAllGEOrders(params),
  getItemFn: (code) => gameData.getItem(code),
  findBestNpcBuyOfferFn: (code) => gameData.findBestNpcBuyOffer(code),
  findBestNpcSellOfferFn: (code) => gameData.findBestNpcSellOffer(code),
};

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
    geLog.info(`[GE] Sell rules loaded — duplicateEquip: ${sellRules.sellDuplicateEquipment}, alwaysSell: ${sellRules.alwaysSell?.length || 0} items, neverSell: ${sellRules.neverSell?.length || 0} items`, {
      event: 'ge.rules.loaded',
      context: {
        operation: 'load_sell_rules',
      },
      data: {
        duplicateEquip: !!sellRules.sellDuplicateEquipment,
        alwaysSellCount: sellRules.alwaysSell?.length || 0,
        neverSellCount: sellRules.neverSell?.length || 0,
      },
    });
  } catch (err) {
    geLog.warn(`[GE] Could not load sell-rules.json: ${err.message} — GE selling disabled`, {
      event: 'ge.rules.load_failed',
      reasonCode: 'request_failed',
      context: {
        operation: 'load_sell_rules',
      },
      error: err,
    });
    sellRules = null;
  }
}

export function getSellRules() {
  return sellRules;
}

// --- Analysis ---

/**
 * Determine which items to sell from bank contents.
 * Duplicate equipment uses the same claim-aware logic as the recycler, while
 * `alwaysSell` acts as an override for matching bank items.
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems - code → quantity
 * @returns {Array<{ code: string, quantity: number, reason: string }>}
 */
export function analyzeSellCandidates(ctx, bankItems) {
  if (!sellRules) return [];

  const candidates = [];
  const seen = new Set();
  const neverSellSet = new Set(sellRules.neverSell || []);

  // Always-sell rules take precedence over normal keep/claim logic for the
  // same item code. `neverSell` remains the hard safety override.
  for (const rule of (sellRules.alwaysSell || [])) {
    if (neverSellSet.has(rule.code)) continue;
    if (seen.has(rule.code)) continue;

    const bankQty = bankItems.get(rule.code) || 0;
    const keepInBank = rule.keepInBank || 0;
    const surplus = bankQty - keepInBank;
    if (surplus <= 0) continue;

    candidates.push({
      code: rule.code,
      quantity: surplus,
      reason: `always-sell override (keeping ${keepInBank})`,
    });
    seen.add(rule.code);
  }

  const duplicateCandidates = analyzeSurplusEquipmentCandidates(ctx, bankItems, {
    sellRules,
    requireCraftable: false,
  });

  for (const candidate of duplicateCandidates) {
    if (seen.has(candidate.code)) continue;
    candidates.push({
      code: candidate.code,
      quantity: candidate.quantity,
      reason: candidate.reason,
    });
    seen.add(candidate.code);
  }

  const heldForNpcSale = getItemsHeldForNpcSale(bankItems);
  return candidates.filter(candidate => !heldForNpcSale.has(candidate.code));
}

// --- Pricing ---

/**
 * Determine a sell price for an item on the GE.
 * Queries current listings and undercuts, or falls back to level-based pricing.
 */
export async function determinePrice(code) {
  const minPrice = sellRules?.minPrice || 1;
  const undercutPct = (sellRules?.undercutPercent || 5) / 100;
  const npcFloor = _deps.findBestNpcSellOfferFn(code)?.sellPrice || 0;
  const npcBuyOffer = _deps.findBestNpcBuyOfferFn(code);
  const npcBuyAnchor = npcBuyOffer
    ? Math.max(0, Math.floor(npcBuyOffer.buyPrice * (1 - undercutPct)))
    : 0;

  try {
    const result = await _deps.getAllGEOrdersFn({ code, type: 'sell', size: 100 });
    const listings = Array.isArray(result) ? result : [];

    if (listings.length > 0) {
      const lowestPrice = Math.min(...listings.map(o => o.price));
      const listingAnchor = Math.floor(lowestPrice * (1 - undercutPct));
      const finalPrice = Math.max(listingAnchor, minPrice, npcFloor, npcBuyAnchor);

      if (npcBuyAnchor > 0 && finalPrice === npcBuyAnchor && npcBuyAnchor > listingAnchor) {
        geLog.debug(`[GE] Pricing ${code}: NPC buy anchor raised price above GE listing undercut (${listingAnchor}g -> ${npcBuyAnchor}g via ${npcBuyOffer.npcCode})`, {
          event: 'ge.pricing.npc_buy_anchor',
          context: {
            operation: 'determine_price',
          },
          data: {
            code,
            lowestListing: lowestPrice,
            listingAnchor,
            npcBuyAnchor,
            npcBuyPrice: npcBuyOffer.buyPrice,
            npcCode: npcBuyOffer.npcCode,
          },
        });
      }

      return finalPrice;
    }
  } catch (err) {
    geLog.warn(`[GE] Could not fetch listings for ${code}: ${err.message}`, {
      event: 'ge.pricing.listings_failed',
      reasonCode: 'request_failed',
      context: {
        operation: 'determine_price',
      },
      data: {
        code,
      },
      error: err,
    });
  }

  // Fallback: price based on item level
  const item = _deps.getItemFn(code);
  const level = item?.level || 1;
  const fallbackPrice = level * 10;
  const finalPrice = Math.max(fallbackPrice, minPrice, npcFloor, npcBuyAnchor);

  if (npcBuyAnchor > 0 && finalPrice === npcBuyAnchor && npcBuyAnchor > fallbackPrice) {
    geLog.debug(`[GE] Pricing ${code}: NPC buy anchor raised fallback price (${fallbackPrice}g -> ${npcBuyAnchor}g via ${npcBuyOffer.npcCode})`, {
      event: 'ge.pricing.npc_buy_anchor',
      context: {
        operation: 'determine_price',
      },
      data: {
        code,
        fallbackPrice,
        npcBuyAnchor,
        npcBuyPrice: npcBuyOffer.buyPrice,
        npcCode: npcBuyOffer.npcCode,
      },
    });
  }

  return finalPrice;
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
      geLog.info(`[${ctx.name}] GE: ${orders.length} active order(s)`, {
        event: 'ge.orders.active',
        context: {
          character: ctx.name,
        },
        data: {
          count: orders.length,
        },
      });
    }

    return orders;
  } catch (err) {
    geLog.warn(`[${ctx.name}] GE: could not fetch orders: ${err.message}`, {
      event: 'ge.orders.fetch_failed',
      reasonCode: 'request_failed',
      context: {
        character: ctx.name,
      },
      error: err,
    });
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
      geLog.info(`[${ctx.name}] GE: cancelling stale order ${order.id} (${order.code} x${order.quantity})`, {
        event: 'ge.order.cancel.start',
        context: {
          character: ctx.name,
        },
        data: {
          orderId: order.id,
          code: order.code,
          quantity: order.quantity,
        },
      });
      const result = await api.cancelGE(order.id, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
      cancelled++;
    } catch (err) {
      geLog.warn(`[${ctx.name}] GE: could not cancel order ${order.id}: ${err.message}`, {
        event: 'ge.order.cancel.failed',
        reasonCode: 'request_failed',
        context: {
          character: ctx.name,
        },
        data: {
          orderId: order.id,
        },
        error: err,
      });
    }
  }

  if (cancelled > 0) {
    geLog.info(`[${ctx.name}] GE: cancelled ${cancelled} stale order(s)`, {
      event: 'ge.order.cancel.done',
      context: {
        character: ctx.name,
      },
      data: {
        cancelled,
      },
    });
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
    geLog.info(`[${ctx.name}] GE: waiting for another character's sell flow to finish`, {
      event: 'ge.sell.lock_wait',
      reasonCode: 'yield_for_backoff',
      context: {
        character: ctx.name,
      },
    });
  }

  return withSellLock(async () => {
    const geLocation = gameData.getGELocation();
    if (!geLocation) {
      geLog.warn(`[${ctx.name}] GE: location unknown, skipping sell flow`, {
        event: 'ge.sell.skipped',
        reasonCode: 'no_path',
        context: {
          character: ctx.name,
        },
      });
      return 0;
    }

    // Force-refresh bank inside the lock to get current state
    const bankItems = await gameData.getBankItems(true);

    const candidates = analyzeSellCandidates(ctx, bankItems);
    // TEMP DEBUG: log forest_ring analysis
    const frBank = bankItems.get('forest_ring') || 0;
    if (frBank > 0) {
      const { getClaimedTotal } = await import('./gear-state.mjs');
      const { globalCount: gc, bankCount: bc } = await import('./inventory-manager.mjs');
      const { getOpenOrderDemandByCode } = await import('./order-board.mjs');
      const demand = getOpenOrderDemandByCode();
      geLog.info(`[${ctx.name}] GE-DEBUG forest_ring: bankMap=${frBank}, globalCount=${gc('forest_ring')}, bankCount=${bc('forest_ring')}, claimed=${getClaimedTotal('forest_ring')}, orderDemand=${demand.get('forest_ring')||0}, candidates=${candidates.filter(c=>c.code==='forest_ring').length}, totalCandidates=${candidates.length}`);
    }
    if (candidates.length === 0) {
      geLog.debug(`[${ctx.name}] GE: no items to sell`, {
        event: 'ge.sell.skipped',
        reasonCode: 'yield_for_backoff',
        context: {
          character: ctx.name,
        },
      });
      return 0;
    }

    geLog.info(`[${ctx.name}] GE: ${candidates.length} item(s) to sell: ${candidates.map(c => `${c.code} x${c.quantity} (${c.reason})`).join(', ')}`, {
      event: 'ge.sell.candidates',
      context: {
        character: ctx.name,
      },
      data: {
        count: candidates.length,
      },
    });

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
      geLog.warn(`[${ctx.name}] GE: could not withdraw ${row.code}: ${row.error}`, {
        event: 'ge.sell.withdraw_failed',
        reasonCode: 'bank_unavailable',
        context: {
          character: ctx.name,
        },
        data: {
          code: row.code,
          error: row.error,
        },
      });
    }
    for (const row of withdrawResult.skipped) {
      if (!row.reason.startsWith('partial fill')) {
        geLog.debug(`[${ctx.name}] GE: skipped ${row.code} (${row.reason})`, {
          event: 'ge.sell.withdraw_skipped',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
          },
          data: {
            code: row.code,
            reason: row.reason,
          },
        });
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
        geLog.info(`[${ctx.name}] GE: withdrawing ${needed}g from bank for listing fees`, {
          event: 'ge.sell.fees_withdraw',
          context: {
            character: ctx.name,
          },
          data: {
            needed,
            totalFees,
            charGold,
          },
        });
        await withdrawGoldFromBank(ctx, needed, { reason: 'GE listing fees withdrawal' });
      } catch (err) {
        geLog.warn(`[${ctx.name}] GE: could not withdraw gold for fees: ${err.message}`, {
          event: 'ge.sell.fees_withdraw_failed',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
          },
          error: err,
        });
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
        geLog.warn(`[${ctx.name}] GE: ${item.code} — inventory has ${actualQty}, expected ${item.quantity}, adjusting`, {
          event: 'ge.sell.quantity_adjusted',
          reasonCode: 'routine_conditions_changed',
          context: {
            character: ctx.name,
          },
          data: {
            code: item.code,
            expected: item.quantity,
            actual: actualQty,
          },
        });
        item.quantity = actualQty;
      }
      if (item.quantity <= 0) continue;

      try {
        const result = await api.sellGE(item.code, item.quantity, item.price, ctx.name);
        ctx.applyActionResult(result);
        await api.waitForCooldown(result);
        ordersCreated++;
        geLog.info(`[${ctx.name}] GE: listed ${item.code} x${item.quantity} @ ${item.price}g each`, {
          event: 'ge.sell.listed',
          context: {
            character: ctx.name,
          },
          data: {
            code: item.code,
            quantity: item.quantity,
            price: item.price,
          },
        });
      } catch (err) {
        if (err.code === 437) {
          geLog.info(`[${ctx.name}] GE: ${item.code} cannot be sold on GE, will re-deposit`, {
            event: 'ge.sell.unsellable',
            reasonCode: 'request_failed',
            context: {
              character: ctx.name,
            },
            data: {
              code: item.code,
            },
          });
        } else if (err.code === 433) {
          geLog.warn(`[${ctx.name}] GE: order limit reached (100), stopping`, {
            event: 'ge.sell.stopped',
            reasonCode: 'request_failed',
            context: {
              character: ctx.name,
            },
            data: {
              code: item.code,
            },
            error: err,
          });
          break;
        } else {
          geLog.warn(`[${ctx.name}] GE: failed to sell ${item.code}: ${err.message}`, {
            event: 'ge.sell.failed',
            reasonCode: 'request_failed',
            context: {
              character: ctx.name,
            },
            data: {
              code: item.code,
            },
            error: err,
          });
        }
      }
    }

    return ordersCreated;
  });
}

export function _setSellRulesForTests(rules = null) {
  sellRules = rules;
}

export function _setDepsForTests(overrides = {}) {
  _deps = {
    ..._deps,
    ...overrides,
  };
}

export function _resetForTests() {
  sellRules = null;
  _sellLock = null;
  _deps = {
    getAllGEOrdersFn: (params) => api.getAllGEOrders(params),
    getItemFn: (code) => gameData.getItem(code),
    findBestNpcBuyOfferFn: (code) => gameData.findBestNpcBuyOffer(code),
    findBestNpcSellOfferFn: (code) => gameData.findBestNpcSellOffer(code),
  };
}
