/**
 * Bank travel — tile discovery, travel-method selection, and movement.
 *
 * Handles finding the nearest bank, deciding whether to use travel potions,
 * and moving the character to a bank tile. Extracted from bank-ops.mjs.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { BANK } from '../data/locations.mjs';
import { canUseItem } from './item-conditions.mjs';
import * as gameData from './game-data.mjs';

let _api = api;
let _bankTilesCache = null;
let _bankTilesFetchedAt = 0;

const BANK_TILE_CACHE_TTL = 5 * 60_000;

export const TRAVEL_POTIONS = Object.freeze({
  recall_potion: { x: 0, y: 0 },
  forest_bank_potion: { x: 7, y: 13 },
});

export const DEFAULT_BANK_TRAVEL_SETTINGS = Object.freeze({
  enabled: true,
  mode: 'smart',
  allowRecall: true,
  allowForestBank: true,
  minSavingsSeconds: 10,
  includeReturnToOrigin: true,
  moveSecondsPerTile: 5,
  itemUseSeconds: 3,
});

// ── helpers ──────────────────────────────────────────────────────────

export function getBankTravelSettings(ctx) {
  const globalEnabled = ctx?.settings?.()?.potions?.enabled !== false;
  const cfg = ctx?.settings?.()?.potions?.bankTravel || {};
  const merged = { ...DEFAULT_BANK_TRAVEL_SETTINGS, ...cfg };
  if (!globalEnabled) merged.enabled = false;
  return merged;
}

export function charPosition(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  try {
    const c = ctx.get();
    if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) return null;
    return { x: c.x, y: c.y };
  } catch {
    return null;
  }
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function isAtAnyBank(pos, bankTiles) {
  if (!pos) return false;
  return bankTiles.some(tile => tile.x === pos.x && tile.y === pos.y);
}

export function nearestBankFrom(pos, bankTiles) {
  if (!bankTiles || bankTiles.length === 0) return { x: BANK.x, y: BANK.y, source: 'fallback' };
  let best = bankTiles[0];
  let bestDist = manhattan(pos, best);
  for (let i = 1; i < bankTiles.length; i++) {
    const tile = bankTiles[i];
    const d = manhattan(pos, tile);
    if (d < bestDist) {
      best = tile;
      bestDist = d;
    }
  }
  return best;
}

export function isAccessibleBankTile(tile) {
  if (!tile) return false;
  if (!Number.isFinite(tile.x) || !Number.isFinite(tile.y)) return false;
  const conditions = tile.access?.conditions;
  return !Array.isArray(conditions) || conditions.length === 0;
}

export async function getAccessibleBankTiles(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _bankTilesCache && (now - _bankTilesFetchedAt) < BANK_TILE_CACHE_TTL) {
    return _bankTilesCache;
  }

  try {
    const maps = await _api.getMaps({ content_type: 'bank', size: 100 });
    const list = Array.isArray(maps) ? maps : [];
    const tiles = list.filter(isAccessibleBankTile).map(tile => ({
      x: tile.x,
      y: tile.y,
      map_id: tile.map_id || null,
      name: tile.name || 'bank',
    }));
    if (tiles.length > 0) {
      _bankTilesCache = tiles;
      _bankTilesFetchedAt = now;
      return tiles;
    }
  } catch (err) {
    log.warn(`[BankTravel] Could not discover bank tiles (${err.message}); falling back to default bank`);
  }

  _bankTilesCache = [{ x: BANK.x, y: BANK.y, map_id: null, name: 'default_bank' }];
  _bankTilesFetchedAt = now;
  return _bankTilesCache;
}

function canUseTravelPotion(ctx, potionCode) {
  if (typeof ctx?.hasItem !== 'function') return false;
  if (!ctx.hasItem(potionCode, 1)) return false;
  const item = gameData.getItem(potionCode);
  if (!item) return true;
  return canUseItem(item, ctx.get());
}

export function chooseTravelMethod(ctx, origin, bankTiles, settings) {
  const moveSec = Math.max(0, Number(settings.moveSecondsPerTile) || 0);
  const useSec = Math.max(0, Number(settings.itemUseSeconds) || 0);
  const includeReturn = settings.includeReturnToOrigin === true;
  const minSavings = Math.max(0, Number(settings.minSavingsSeconds) || 0);

  const directTarget = nearestBankFrom(origin, bankTiles);
  const directInbound = manhattan(origin, directTarget) * moveSec;
  const directReturn = includeReturn ? (manhattan(directTarget, origin) * moveSec) : 0;
  const directTotal = directInbound + directReturn;

  const methods = [{
    type: 'direct',
    potion: null,
    totalSeconds: directTotal,
    inboundSeconds: directInbound,
    bankTarget: directTarget,
  }];

  const allowRecall = settings.allowRecall !== false;
  const allowForestBank = settings.allowForestBank !== false;
  const candidates = [];
  if (allowRecall) candidates.push('recall_potion');
  if (allowForestBank) candidates.push('forest_bank_potion');

  for (const code of candidates) {
    if (!canUseTravelPotion(ctx, code)) continue;
    const destination = TRAVEL_POTIONS[code];
    if (!destination) continue;

    const bankTarget = nearestBankFrom(destination, bankTiles);
    const inbound = useSec + (manhattan(destination, bankTarget) * moveSec);
    const outbound = includeReturn ? (manhattan(bankTarget, origin) * moveSec) : 0;
    methods.push({
      type: 'teleport',
      potion: code,
      totalSeconds: inbound + outbound,
      inboundSeconds: inbound,
      bankTarget,
    });
  }

  let best = methods[0];
  for (let i = 1; i < methods.length; i++) {
    if (methods[i].totalSeconds < best.totalSeconds) best = methods[i];
  }

  const savings = directTotal - best.totalSeconds;
  if (best.type === 'teleport' && savings >= minSavings) {
    return {
      ...best,
      savingsSeconds: savings,
      directSeconds: directTotal,
    };
  }

  return {
    ...methods[0],
    savingsSeconds: 0,
    directSeconds: directTotal,
  };
}

async function moveToBankTile(ctx, bankTile) {
  const pos = charPosition(ctx);
  if (pos) {
    log.info(`[${ctx.name}] Moving (${pos.x},${pos.y}) → (${bankTile.x},${bankTile.y})`);
  } else {
    log.info(`[${ctx.name}] Moving to bank (${bankTile.x},${bankTile.y})`);
  }
  const action = await _api.move(bankTile.x, bankTile.y, ctx.name);
  ctx.applyActionResult(action);
  await _api.waitForCooldown(action);
}

// ── main entry point ─────────────────────────────────────────────────

export async function ensureAtBank(ctx) {
  const bankTiles = await getAccessibleBankTiles();
  const origin = charPosition(ctx);
  if (origin && isAtAnyBank(origin, bankTiles)) return;

  const settings = getBankTravelSettings(ctx);
  const fallbackTarget = nearestBankFrom(origin || { x: BANK.x, y: BANK.y }, bankTiles);
  if (!settings.enabled || settings.mode !== 'smart' || !origin) {
    await moveToBankTile(ctx, fallbackTarget);
    return;
  }

  const chosen = chooseTravelMethod(ctx, origin, bankTiles, settings);
  if (chosen.type === 'teleport' && chosen.potion) {
    log.info(`[${ctx.name}] BankTravel: using ${chosen.potion} (save ~${chosen.savingsSeconds}s, direct ${chosen.directSeconds}s)`);
    try {
      const useResult = await _api.useItem(chosen.potion, 1, ctx.name);
      ctx.applyActionResult(useResult);
      await _api.waitForCooldown(useResult);
      const afterTeleport = charPosition(ctx) || origin;
      const target = nearestBankFrom(afterTeleport, bankTiles);
      if (!isAtAnyBank(afterTeleport, bankTiles)) {
        await moveToBankTile(ctx, target);
      }
      return;
    } catch (err) {
      log.warn(`[${ctx.name}] BankTravel: ${chosen.potion} failed (${err.message}), falling back to direct move`);
      await moveToBankTile(ctx, fallbackTarget);
      return;
    }
  }

  await moveToBankTile(ctx, chosen.bankTarget || fallbackTarget);
}

// ── initialization & test helpers ────────────────────────────────────

export function _setApiClient(client) {
  _api = client;
}

export function _resetForTests() {
  _bankTilesCache = null;
  _bankTilesFetchedAt = 0;
}
