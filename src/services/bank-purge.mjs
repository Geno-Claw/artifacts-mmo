/**
 * Bank Slot Pressure Relief — automatically sells low-value bank items
 * to NPC vendors when the bank is running out of unique item slots.
 *
 * Only triggers when bank slot usage >= triggerPct (default 95%).
 * Prioritizes selling items with lowest total value first.
 *
 * Items are safe to purge if:
 * 1. Sellable to an NPC vendor (has a sell offer)
 * 2. Not claimed gear (not assigned to any character)
 * 3. Not demanded by any open order on the order board
 * 4. Not on the neverPurge list
 *
 * Configurable via `bankPurge` in characters.json:
 *   {
 *     "enabled": true,
 *     "triggerPct": 0.95,       // trigger at 95% slot usage
 *     "targetFreeSlots": 10,    // aim to free this many slots
 *     "neverPurge": ["enchanted_fabric", ...],
 *     "alwaysPurge": [{ "code": "cowhide", "keepInBank": 0 }, ...]
 *   }
 */
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { getBankSummary, getBankItems } from './inventory-manager.mjs';
import { getOpenOrderDemandByCode } from './order-board.mjs';
import { isClaimedByAnyCharacter } from './gear-state.mjs';
import { withdrawBankItems } from './bank-ops.mjs';
import { moveTo, NoPathError } from '../helpers.mjs';
import * as api from '../api.mjs';
import { getPreferredNpcTile } from './npc-purchase.mjs';

const purgeLog = log.createLogger({ scope: 'service.bank-purge' });

let config = {
  enabled: false,
  triggerPct: 0.95,
  targetFreeSlots: 10,
  neverPurge: new Set(),
  alwaysPurge: [],  // [{ code, keepInBank }]
};

export function loadBankPurgeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    config = { enabled: false, triggerPct: 0.95, targetFreeSlots: 10, neverPurge: new Set(), alwaysPurge: [] };
    return;
  }

  config = {
    enabled: raw.enabled === true,
    triggerPct: Math.max(0.5, Math.min(1.0, Number(raw.triggerPct) || 0.95)),
    targetFreeSlots: Math.max(1, Math.floor(Number(raw.targetFreeSlots) || 10)),
    neverPurge: new Set(Array.isArray(raw.neverPurge) ? raw.neverPurge : []),
    alwaysPurge: Array.isArray(raw.alwaysPurge)
      ? raw.alwaysPurge.filter(e => e?.code).map(e => ({
        code: e.code,
        keepInBank: Math.max(0, Math.floor(Number(e.keepInBank) || 0)),
      }))
      : [],
  };
}

export function isBankPurgeEnabled() {
  return config.enabled;
}

/**
 * Check if bank slot pressure warrants a purge.
 */
export function shouldPurge() {
  if (!config.enabled) return false;
  const summary = getBankSummary();
  if (summary.slots <= 0) return false;
  return (summary.usedSlots / summary.slots) >= config.triggerPct;
}

/**
 * Analyze what can be purged. Returns sorted candidates.
 */
export async function analyzePurgeCandidates() {
  const bankItems = await getBankItems(true);
  const orderDemand = getOpenOrderDemandByCode();
  const summary = getBankSummary();

  const slotsToFree = Math.max(0, summary.usedSlots - (summary.slots - config.targetFreeSlots));
  if (slotsToFree <= 0) return { candidates: [], slotsToFree: 0 };

  const candidates = [];

  // First: always-purge items (explicit config)
  for (const rule of config.alwaysPurge) {
    const bankQty = bankItems.get(rule.code) || 0;
    if (bankQty <= rule.keepInBank) continue;

    const sellQty = bankQty - rule.keepInBank;
    const offer = gameData.findBestNpcSellOffer(rule.code);

    candidates.push({
      code: rule.code,
      quantity: sellQty,
      freesSlot: rule.keepInBank === 0,
      totalValue: offer ? offer.sellPrice * sellQty : 0,
      sellPrice: offer?.sellPrice || 0,
      npcCode: offer?.npcCode || null,
      currency: offer?.currency || 'gold',
      reason: 'always_purge',
    });
  }

  // Then: auto-detect candidates
  for (const [code, bankQty] of bankItems.entries()) {
    if (bankQty <= 0) continue;
    if (config.neverPurge.has(code)) continue;
    if (candidates.some(c => c.code === code)) continue; // already in always-purge

    // Skip items claimed as gear
    if (isClaimedByAnyCharacter(code)) continue;

    // Skip items needed by orders
    const orderNeed = orderDemand.get(code) || 0;
    if (orderNeed > 0) continue;

    // Must be sellable to an NPC
    const offer = gameData.findBestNpcSellOffer(code);
    if (!offer) continue;

    candidates.push({
      code,
      quantity: bankQty,
      freesSlot: true,
      totalValue: offer.sellPrice * bankQty,
      sellPrice: offer.sellPrice,
      npcCode: offer.npcCode,
      currency: offer.currency,
      reason: 'auto_detected',
    });
  }

  // Sort: lowest total value first (sell least valuable items first)
  candidates.sort((a, b) => a.totalValue - b.totalValue);

  return { candidates, slotsToFree };
}

/**
 * Execute the bank purge — withdraw and sell items to free slots.
 * @param {import('../context.mjs').CharacterContext} ctx
 * @returns {Promise<{ slotsFree: number, itemsSold: number, goldEarned: number }>}
 */
export async function executeBankPurge(ctx) {
  if (!shouldPurge()) {
    return { slotsFree: 0, itemsSold: 0, goldEarned: 0 };
  }

  const { candidates, slotsToFree } = await analyzePurgeCandidates();
  if (candidates.length === 0 || slotsToFree <= 0) {
    purgeLog.info(`[${ctx.name}] Bank purge: no purgeable items found (need ${slotsToFree} slots)`, {
      event: 'bank_purge.no_candidates',
      context: { character: ctx.name },
      data: { slotsToFree },
    });
    return { slotsFree: 0, itemsSold: 0, goldEarned: 0 };
  }

  purgeLog.info(`[${ctx.name}] Bank purge: ${candidates.length} candidates, need to free ${slotsToFree} slot(s)`, {
    event: 'bank_purge.start',
    context: { character: ctx.name },
    data: {
      slotsToFree,
      candidates: candidates.map(c => ({ code: c.code, qty: c.quantity, value: c.totalValue, reason: c.reason })),
    },
  });

  let slotsFree = 0;
  let itemsSold = 0;
  let goldEarned = 0;

  // Group by NPC for efficiency
  const byNpc = new Map();
  let slotsPlanned = 0;

  for (const candidate of candidates) {
    if (slotsPlanned >= slotsToFree) break;
    if (!candidate.npcCode) continue;

    let group = byNpc.get(candidate.npcCode);
    if (!group) {
      group = [];
      byNpc.set(candidate.npcCode, group);
    }
    group.push(candidate);
    if (candidate.freesSlot) slotsPlanned++;
  }

  for (const [npcCode, items] of byNpc.entries()) {
    // Find NPC location
    let tile;
    try {
      tile = await getPreferredNpcTile(npcCode);
    } catch {
      tile = null;
    }
    if (!tile) {
      purgeLog.warn(`[${ctx.name}] Bank purge: NPC ${npcCode} not found, skipping ${items.length} item(s)`, {
        event: 'bank_purge.npc_not_found',
        context: { character: ctx.name },
        data: { npcCode, items: items.map(i => i.code) },
      });
      continue;
    }

    // Withdraw items from bank
    const withdrawRequests = items.map(i => ({ code: i.code, qty: i.quantity }));
    let withdrawn;
    try {
      withdrawn = await withdrawBankItems(ctx, withdrawRequests, {
        reason: `bank purge for NPC ${npcCode}`,
        mode: 'partial',
        retryStaleOnce: true,
      });
    } catch (err) {
      purgeLog.warn(`[${ctx.name}] Bank purge: withdraw failed: ${err.message}`, {
        event: 'bank_purge.withdraw_failed',
        context: { character: ctx.name },
        error: err,
      });
      continue;
    }

    // Move to NPC
    try {
      await moveTo(ctx, tile.x, tile.y);
    } catch (err) {
      if (err instanceof NoPathError) {
        purgeLog.warn(`[${ctx.name}] Bank purge: no path to ${npcCode}`, {
          event: 'bank_purge.no_path',
          context: { character: ctx.name },
          data: { npcCode },
        });
        continue;
      }
      throw err;
    }

    // Sell each item
    for (const item of items) {
      const carried = ctx.itemCount(item.code);
      if (carried <= 0) continue;

      try {
        const result = await api.npcSell(item.code, carried, ctx.name);
        ctx.applyActionResult(result);
        await api.waitForCooldown(result);

        itemsSold += carried;
        goldEarned += item.sellPrice * carried;
        if (item.freesSlot) slotsFree++;

        purgeLog.info(`[${ctx.name}] Bank purge: sold ${item.code} x${carried} to ${npcCode} for ${item.sellPrice * carried}g`, {
          event: 'bank_purge.sold',
          context: { character: ctx.name },
          data: {
            code: item.code,
            quantity: carried,
            npcCode,
            sellPrice: item.sellPrice,
            totalGold: item.sellPrice * carried,
            reason: item.reason,
          },
        });
      } catch (err) {
        purgeLog.warn(`[${ctx.name}] Bank purge: failed to sell ${item.code}: ${err.message}`, {
          event: 'bank_purge.sell_failed',
          context: { character: ctx.name },
          data: { code: item.code, npcCode },
          error: err,
        });
      }
    }
  }

  purgeLog.info(`[${ctx.name}] Bank purge complete: freed ${slotsFree} slot(s), sold ${itemsSold} item(s), earned ${goldEarned}g`, {
    event: 'bank_purge.complete',
    context: { character: ctx.name },
    data: { slotsFree, itemsSold, goldEarned },
  });

  return { slotsFree, itemsSold, goldEarned };
}
