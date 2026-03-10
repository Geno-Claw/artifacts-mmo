import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import * as eventManager from './event-manager.mjs';
import { moveTo, NoPathError } from '../helpers.mjs';
import { withdrawBankItems } from './bank-ops.mjs';
import { analyzeSurplusEquipmentCandidates } from './equipment-surplus.mjs';
import { getPreferredNpcTile } from './npc-purchase.mjs';
import { getItemsForNpcSell, getNpcSellList } from './npc-sell-config.mjs';

const npcSellLog = log.createLogger({ scope: 'service.npc-seller' });
const NPC_SELL_ACTION_LIMIT = 100;

const deps = {
  getPreferredNpcTileFn: (npcCode) => getPreferredNpcTile(npcCode),
  getActiveNpcEventsFn: () => eventManager.getActiveNpcEvents(),
  getNpcEventCodesFn: () => eventManager.getNpcEventCodes(),
  getBankItemsFn: (forceRefresh = false) => gameData.getBankItems(forceRefresh),
  withdrawBankItemsFn: (ctx, requests, opts) => withdrawBankItems(ctx, requests, opts),
  moveToFn: (ctx, x, y) => moveTo(ctx, x, y),
  npcSellFn: (code, quantity, name) => api.npcSell(code, quantity, name),
  waitForCooldownFn: (result) => api.waitForCooldown(result),
  analyzeSurplusEquipmentCandidatesFn: (ctx, bankItems, opts) => analyzeSurplusEquipmentCandidates(ctx, bankItems, opts),
};

const staticNpcTileCache = new Map(); // npcCode -> tile|null

async function getStaticNpcTile(npcCode) {
  if (staticNpcTileCache.has(npcCode)) {
    return staticNpcTileCache.get(npcCode);
  }
  try {
    const tile = await deps.getPreferredNpcTileFn(npcCode);
    staticNpcTileCache.set(npcCode, tile || null);
    return tile || null;
  } catch {
    staticNpcTileCache.set(npcCode, null);
    return null;
  }
}

function getActiveNpcEvent(npcCode) {
  const events = deps.getActiveNpcEventsFn();
  return events.find(evt => evt.contentCode === npcCode || evt.code === npcCode) || null;
}

async function resolveNpcAvailability(npcCode) {
  const tile = await getStaticNpcTile(npcCode);
  if (tile) {
    return {
      npcCode,
      npcIsEvent: false,
      npcAvailable: true,
      map: { x: tile.x, y: tile.y },
    };
  }

  const activeEvent = getActiveNpcEvent(npcCode);
  const isEventNpc = deps.getNpcEventCodesFn().includes(npcCode) || !!activeEvent;
  return {
    npcCode,
    npcIsEvent: isEventNpc,
    npcAvailable: !!activeEvent?.map,
    map: activeEvent?.map || null,
  };
}

function buildOverrideCandidates(bankItems, neverSellSet) {
  const candidates = [];
  const seen = new Set();
  const rawSellList = getNpcSellList();

  for (const [npcCode, entries] of Object.entries(rawSellList)) {
    if (npcCode === '_any' || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const code = entry?.code;
      if (!code || seen.has(code) || neverSellSet.has(code)) continue;

      const bankQty = bankItems.get(code) || 0;
      const keepInBank = Math.max(0, Number(entry?.keepInBank) || 0);
      const quantity = Math.max(0, bankQty - keepInBank);
      if (quantity <= 0) continue;

      candidates.push({
        code,
        quantity,
        reason: `npc-sell override (keeping ${keepInBank})`,
        preferredNpcCode: npcCode,
      });
      seen.add(code);
    }
  }

  for (const entry of getItemsForNpcSell('_any')) {
    const code = entry?.code;
    if (!code || seen.has(code) || neverSellSet.has(code)) continue;

    const bankQty = bankItems.get(code) || 0;
    const keepInBank = Math.max(0, Number(entry?.keepInBank) || 0);
    const quantity = Math.max(0, bankQty - keepInBank);
    if (quantity <= 0) continue;

    candidates.push({
      code,
      quantity,
      reason: `npc-sell override (keeping ${keepInBank})`,
      preferredNpcCode: null,
    });
    seen.add(code);
  }

  return { candidates, seen };
}

function getSellRulesSets(sellRules = null) {
  const rules = sellRules && typeof sellRules === 'object' ? sellRules : null;
  return {
    sellRules: rules,
    neverSellSet: new Set(rules?.neverSell || []),
    alwaysSellList: Array.isArray(rules?.alwaysSell) ? rules.alwaysSell : [],
  };
}

function pushAlwaysSellCandidates(bankItems, seen, neverSellSet, alwaysSellList, candidates) {
  for (const rule of alwaysSellList) {
    const code = rule?.code;
    if (!code || seen.has(code) || neverSellSet.has(code)) continue;

    const bankQty = bankItems.get(code) || 0;
    const keepInBank = Math.max(0, Number(rule?.keepInBank) || 0);
    const quantity = Math.max(0, bankQty - keepInBank);
    if (quantity <= 0) continue;

    candidates.push({
      code,
      quantity,
      reason: `always-sell override (keeping ${keepInBank})`,
      preferredNpcCode: null,
    });
    seen.add(code);
  }
}

function pushDuplicateEquipmentCandidates(ctx, bankItems, seen, sellRules, candidates) {
  const duplicateCandidates = deps.analyzeSurplusEquipmentCandidatesFn(ctx, bankItems, {
    sellRules,
    requireCraftable: false,
  });

  for (const candidate of duplicateCandidates) {
    if (!candidate?.code || seen.has(candidate.code)) continue;
    candidates.push({
      code: candidate.code,
      quantity: candidate.quantity,
      reason: candidate.reason,
      preferredNpcCode: null,
    });
    seen.add(candidate.code);
  }
}

async function resolveCandidateOffer(candidate) {
  if (candidate.preferredNpcCode) {
    const offer = gameData.getNpcSellOffer(candidate.preferredNpcCode, candidate.code);
    if (!offer) return null;
    return {
      npcCode: candidate.preferredNpcCode,
      currency: offer.currency,
      sellPrice: offer.sellPrice,
    };
  }

  return gameData.findBestNpcSellOffer(candidate.code);
}

function collectNpcSellCandidates(ctx, bankItems, opts = {}) {
  const { sellRules, neverSellSet, alwaysSellList } = getSellRulesSets(opts.sellRules);
  const { candidates, seen } = buildOverrideCandidates(bankItems, neverSellSet);

  pushAlwaysSellCandidates(bankItems, seen, neverSellSet, alwaysSellList, candidates);
  pushDuplicateEquipmentCandidates(ctx, bankItems, seen, sellRules, candidates);

  const resolved = [];
  for (const candidate of candidates) {
    if (neverSellSet.has(candidate.code)) continue;
    resolved.push(candidate);
  }
  return resolved;
}

function buildWithdrawBatch(rows, ctx) {
  let remainingSpace = Math.max(0, ctx.inventoryCapacity() - ctx.inventoryCount());
  if (remainingSpace <= 0) return [];

  const batch = [];
  for (const row of rows) {
    const remaining = Math.max(0, Number(row.remaining) || 0);
    if (remaining <= 0) continue;

    const qty = Math.min(remaining, remainingSpace, NPC_SELL_ACTION_LIMIT);
    if (qty <= 0) continue;

    batch.push({ code: row.code, quantity: qty });
    remainingSpace -= qty;
    if (remainingSpace <= 0) break;
  }
  return batch;
}

function buildInventoryBatch(ctx, rows) {
  const batch = [];
  for (const row of rows) {
    const remaining = Math.max(0, Number(row.remaining) || 0);
    if (remaining <= 0) continue;

    const carried = Math.max(0, Number(ctx.itemCount(row.code)) || 0);
    const qty = Math.min(remaining, carried, NPC_SELL_ACTION_LIMIT);
    if (qty > 0) batch.push({ row, quantity: qty });
  }
  return batch;
}

async function moveToNpc(ctx, destination, npcCode) {
  if (!destination?.map) return false;
  if (ctx.isAt(destination.map.x, destination.map.y)) return true;

  try {
    await deps.moveToFn(ctx, destination.map.x, destination.map.y);
    return true;
  } catch (err) {
    if (err instanceof NoPathError) {
      npcSellLog.warn(`[${ctx.name}] NPC sell: no path to ${npcCode} at (${destination.map.x},${destination.map.y})`, {
        event: 'npc_sell.travel_failed',
        reasonCode: 'no_path',
        context: {
          character: ctx.name,
        },
        data: {
          npcCode,
          x: destination.map.x,
          y: destination.map.y,
        },
      });
      return false;
    }
    throw err;
  }
}

async function executeNpcGroup(ctx, npcCode, rows) {
  let soldQuantity = 0;
  let destination = await resolveNpcAvailability(npcCode);
  if (!destination.npcAvailable || !destination.map) return 0;

  const queue = rows.map(row => ({
    ...row,
    remaining: Math.max(0, Number(row.quantity) || 0),
  }));

  while (queue.some(row => row.remaining > 0)) {
    let batch = buildInventoryBatch(ctx, queue);

    if (batch.length === 0) {
      const requests = buildWithdrawBatch(queue, ctx);
      if (requests.length === 0) break;

      const withdrawResult = await deps.withdrawBankItemsFn(ctx, requests, {
        reason: `NPC sell flow withdrawal (${npcCode})`,
        mode: 'partial',
        retryStaleOnce: true,
      });

      for (const row of withdrawResult.failed) {
        npcSellLog.warn(`[${ctx.name}] NPC sell: could not withdraw ${row.code}: ${row.error}`, {
          event: 'npc_sell.withdraw_failed',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
          },
          data: {
            npcCode,
            code: row.code,
            error: row.error,
          },
        });
      }

      batch = withdrawResult.withdrawn
        .map((withdrawn) => {
          const row = queue.find(entry => entry.code === withdrawn.code && entry.remaining > 0);
          if (!row) return null;
          return { row, quantity: Math.min(withdrawn.quantity, row.remaining) };
        })
        .filter(Boolean);

      if (batch.length === 0) break;

      destination = await resolveNpcAvailability(npcCode);
      if (!destination.npcAvailable || !destination.map) break;
    }

    const moved = await moveToNpc(ctx, destination, npcCode);
    if (!moved) break;

    for (const entry of batch) {
      const { row } = entry;
      const quantity = Math.min(entry.quantity, row.remaining, Math.max(0, Number(ctx.itemCount(row.code)) || 0), NPC_SELL_ACTION_LIMIT);
      if (quantity <= 0) continue;

      try {
        const result = await deps.npcSellFn(row.code, quantity, ctx.name);
        ctx.applyActionResult(result);
        await deps.waitForCooldownFn(result);
        row.remaining -= quantity;
        soldQuantity += quantity;

        npcSellLog.info(
          `[${ctx.name}] NPC sell ${npcCode}: sold ${row.code} x${quantity} for ${row.sellPrice} ${row.currency} each (${row.reason})`,
          {
            event: 'npc_sell.sold',
            context: {
              character: ctx.name,
            },
            data: {
              npcCode,
              code: row.code,
              quantity,
              sellPrice: row.sellPrice,
              currency: row.currency,
            },
          },
        );
      } catch (err) {
        if (err?.code === 598) {
          npcSellLog.warn(`[${ctx.name}] NPC sell: ${npcCode} disappeared during sale`, {
            event: 'npc_sell.npc_gone',
            reasonCode: 'request_failed',
            context: {
              character: ctx.name,
            },
            data: {
              npcCode,
            },
            error: err,
          });
          return soldQuantity;
        }

        npcSellLog.warn(`[${ctx.name}] NPC sell: could not sell ${row.code} to ${npcCode}: ${err.message}`, {
          event: 'npc_sell.item_failed',
          reasonCode: 'request_failed',
          context: {
            character: ctx.name,
          },
          data: {
            npcCode,
            code: row.code,
          },
          error: err,
        });
        row.remaining = 0;
      }
    }
  }

  return soldQuantity;
}

/**
 * Determine which items should be sold to NPC vendors from bank contents.
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems
 * @param {{ sellRules?: object|null, npcCode?: string|null }} [opts]
 * @returns {Promise<Array<{
 *   code: string,
 *   quantity: number,
 *   npcCode: string,
 *   sellPrice: number,
 *   currency: string,
 *   reason: string,
 *   npcIsEvent: boolean,
 *   npcAvailable: boolean,
 *   map?: { x: number, y: number } | null,
 * }>>}
 */
export async function analyzeNpcSellCandidates(ctx, bankItems, opts = {}) {
  const resolved = [];
  for (const candidate of collectNpcSellCandidates(ctx, bankItems, opts)) {
    const offer = await resolveCandidateOffer(candidate);
    if (!offer) continue;
    if (opts.npcCode && offer.npcCode !== opts.npcCode) continue;

    const availability = await resolveNpcAvailability(offer.npcCode);
    resolved.push({
      code: candidate.code,
      quantity: candidate.quantity,
      npcCode: offer.npcCode,
      sellPrice: offer.sellPrice,
      currency: offer.currency,
      reason: candidate.reason,
      npcIsEvent: availability.npcIsEvent,
      npcAvailable: availability.npcAvailable,
      map: availability.map,
    });
  }

  resolved.sort((a, b) => {
    if (a.npcAvailable !== b.npcAvailable) return a.npcAvailable ? -1 : 1;
    return (b.sellPrice * b.quantity) - (a.sellPrice * a.quantity);
  });

  return resolved;
}

export function getNpcSellCandidates(ctx, bankItems, opts = {}) {
  const resolved = [];
  for (const candidate of collectNpcSellCandidates(ctx, bankItems, opts)) {
    const offer = candidate.preferredNpcCode
      ? gameData.getNpcSellOffer(candidate.preferredNpcCode, candidate.code)
      : gameData.findBestNpcSellOffer(candidate.code);
    if (!offer) continue;
    const npcCode = candidate.preferredNpcCode || offer.npcCode;
    if (opts.npcCode && npcCode !== opts.npcCode) continue;

    resolved.push({
      code: candidate.code,
      quantity: candidate.quantity,
      npcCode,
      sellPrice: offer.sellPrice,
      currency: offer.currency,
      reason: candidate.reason,
    });
  }
  return resolved;
}

export function getItemsHeldForNpcSale(bankItems) {
  const held = new Set();
  if (!(bankItems instanceof Map)) return held;

  for (const [code, quantity] of bankItems.entries()) {
    if ((Number(quantity) || 0) <= 0) continue;
    if (gameData.findBestNpcSellOffer(code)) {
      held.add(code);
    }
  }

  return held;
}

/**
 * Execute the NPC vendor sell flow for all currently available vendors.
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {{ sellRules?: object|null, npcCode?: string|null }} [opts]
 * @returns {Promise<number>} Total quantity sold
 */
export async function executeNpcSellFlow(ctx, opts = {}) {
  const bankItems = await deps.getBankItemsFn(true);
  const candidates = await analyzeNpcSellCandidates(ctx, bankItems, opts);
  const available = candidates.filter(row => row.npcAvailable);
  if (available.length === 0) return 0;

  const byNpc = new Map();
  for (const row of available) {
    let rows = byNpc.get(row.npcCode);
    if (!rows) {
      rows = [];
      byNpc.set(row.npcCode, rows);
    }
    rows.push(row);
  }

  let soldQuantity = 0;
  for (const [npcCode, rows] of byNpc.entries()) {
    soldQuantity += await executeNpcGroup(ctx, npcCode, rows);
  }
  return soldQuantity;
}

export function _setDepsForTests(overrides = {}) {
  Object.assign(deps, overrides);
}

export function _resetForTests() {
  deps.getPreferredNpcTileFn = (npcCode) => getPreferredNpcTile(npcCode);
  deps.getActiveNpcEventsFn = () => eventManager.getActiveNpcEvents();
  deps.getNpcEventCodesFn = () => eventManager.getNpcEventCodes();
  deps.getBankItemsFn = (forceRefresh = false) => gameData.getBankItems(forceRefresh);
  deps.withdrawBankItemsFn = (ctx, requests, opts) => withdrawBankItems(ctx, requests, opts);
  deps.moveToFn = (ctx, x, y) => moveTo(ctx, x, y);
  deps.npcSellFn = (code, quantity, name) => api.npcSell(code, quantity, name);
  deps.waitForCooldownFn = (result) => api.waitForCooldown(result);
  deps.analyzeSurplusEquipmentCandidatesFn = (ctx, bankItems, opts) => analyzeSurplusEquipmentCandidates(ctx, bankItems, opts);
  staticNpcTileCache.clear();
}
