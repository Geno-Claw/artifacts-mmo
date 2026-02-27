/**
 * Gear loadout application — shared by combat & gathering routines.
 *
 * Handles equipment swaps, bank withdrawal of missing pieces, and
 * caching of optimized loadouts. Extracted from helpers.mjs.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';
import { optimizeForMonster, optimizeForGathering } from './gear-optimizer.mjs';
import { ensureMissingGatherToolOrder } from './tool-policy.mjs';
import {
  depositBankItems,
  withdrawBankItems,
} from './bank-ops.mjs';
import { getOwnedKeepByCodeForInventory } from './gear-state.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';
import { swapEquipment, depositAll } from '../helpers.mjs';

// ── helpers ──────────────────────────────────────────────────────────

function buildDepositRowsRespectingKeep(ctx, codes, keepByCode = {}) {
  const keepRemaining = new Map(
    Object.entries(keepByCode || {})
      .map(([code, qty]) => [code, Math.max(0, Number(qty) || 0)]),
  );
  const uniqueCodes = [...new Set((Array.isArray(codes) ? codes : []).filter(Boolean))];
  const rows = [];

  for (const code of uniqueCodes) {
    const qty = Math.max(0, Number(ctx.itemCount(code)) || 0);
    if (qty <= 0) continue;

    const keep = keepRemaining.get(code) || 0;
    const depositQty = Math.max(0, qty - keep);
    keepRemaining.set(code, Math.max(0, keep - qty));
    if (depositQty <= 0) continue;
    rows.push({ code, quantity: depositQty });
  }

  return rows;
}

// ── core loadout application ─────────────────────────────────────────

/**
 * Apply a target gear loadout: compute slot changes, withdraw from bank if
 * needed, perform equipment swaps, and deposit old gear.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, string|null>} loadout — slot → itemCode (or null to unequip)
 * @param {object} opts
 * @param {string} opts.reason — log/audit label (e.g. "combat gear for chicken")
 * @param {boolean} [opts.abortOnMissing=false] — if true, return early without
 *   swapping when any target item is unavailable after bank withdrawal
 * @returns {Promise<{ changed: boolean, swapsFailed: boolean, missingSlots: string[] }>}
 */
async function applyGearLoadout(ctx, loadout, { reason = 'gear swap', abortOnMissing = false } = {}) {
  // Determine which slots need changing
  const changes = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const currentCode = ctx.get()[`${slot}_slot`] || null;
    const targetCode = loadout.get(slot) || null;
    if (currentCode !== targetCode) {
      changes.push({ slot, currentCode, targetCode });
    }
  }

  if (changes.length === 0) {
    return { changed: false, swapsFailed: false, missingSlots: [] };
  }

  log.info(`[${ctx.name}] ${reason}: ${changes.length} slot(s) to change`);

  // Determine if any items need to come from bank
  const desiredByCode = new Map();
  for (const change of changes) {
    if (!change.targetCode) continue;
    desiredByCode.set(change.targetCode, (desiredByCode.get(change.targetCode) || 0) + 1);
  }

  const bankNeeded = new Map();
  for (const [code, desired] of desiredByCode.entries()) {
    const missing = Math.max(0, desired - ctx.itemCount(code));
    if (missing > 0) bankNeeded.set(code, missing);
  }

  if (bankNeeded.size > 0) {
    // Ensure inventory space for swaps — check both unique slot availability
    // and total quantity capacity. Bags increase both limits.
    const slotsNeedingUnequip = changes.filter(c => c.currentCode && c.targetCode).length;
    const newItemTypes = [...bankNeeded.keys()].filter(code => !ctx.hasItem(code)).length;
    const needsSlotSpace = newItemTypes > 0 && ctx.inventoryEmptySlots() < newItemTypes + slotsNeedingUnequip;
    const needsQtySpace = ctx.inventoryCount() + slotsNeedingUnequip >= ctx.inventoryCapacity();
    if (needsSlotSpace || needsQtySpace) {
      await depositAll(ctx, { keepByCode: getOwnedKeepByCodeForInventory(ctx) });
    }

    const requests = [...bankNeeded.entries()].map(([code, qty]) => ({ code, qty }));
    const wdResult = await withdrawBankItems(ctx, requests, {
      reason,
      mode: 'partial',
      retryStaleOnce: true,
    });
    logWithdrawalWarnings(ctx, wdResult);
  }

  // Check for missing items after bank withdrawal
  const missingSlots = [];
  for (const { slot, targetCode } of changes) {
    if (!targetCode) continue;
    if (!ctx.hasItem(targetCode) && ctx.get()[`${slot}_slot`] !== targetCode) {
      missingSlots.push(`${slot}:${targetCode}`);
    }
  }
  if (abortOnMissing && missingSlots.length > 0) {
    return { changed: false, swapsFailed: true, missingSlots };
  }

  // Perform equipment swaps
  let swapsFailed = false;
  for (const { slot, currentCode, targetCode } of changes) {
    if (targetCode === null) {
      // Unequip only
      if (currentCode) {
        if (ctx.inventoryFull()) {
          log.warn(`[${ctx.name}] Inventory full, cannot unequip ${slot}`);
          swapsFailed = true;
          continue;
        }
        log.info(`[${ctx.name}] Unequipping ${currentCode} from ${slot}`);
        const ur = await api.unequipItem(slot, ctx.name);
        ctx.applyActionResult(ur);
        await api.waitForCooldown(ur);
      }
    } else {
      if (!ctx.hasItem(targetCode) && ctx.get()[`${slot}_slot`] !== targetCode) {
        log.warn(`[${ctx.name}] Skipping ${slot} swap: ${targetCode} not in inventory`);
        swapsFailed = true;
        continue;
      }
      try {
        await swapEquipment(ctx, slot, targetCode);
      } catch (err) {
        log.warn(`[${ctx.name}] Gear swap failed for ${slot}: ${err.message}`);
        swapsFailed = true;
      }
    }
  }

  // Deposit old gear to bank if we made a bank trip
  if (bankNeeded.size > 0) {
    const unequippedCodes = changes
      .filter(c => c.currentCode && c.currentCode !== c.targetCode)
      .map(c => c.currentCode)
      .filter(code => ctx.hasItem(code));

    if (unequippedCodes.length > 0) {
      const keepByCode = getOwnedKeepByCodeForInventory(ctx);
      const items = buildDepositRowsRespectingKeep(ctx, unequippedCodes, keepByCode);
      if (items.length > 0) {
        try {
          await depositBankItems(ctx, items, { reason: `${reason} cleanup` });
        } catch (err) {
          log.warn(`[${ctx.name}] Could not deposit old gear: ${err.message}`);
        }
      }
    }
  }

  return { changed: true, swapsFailed, missingSlots: [] };
}

// ── combat gear optimization ─────────────────────────────────────────

// Cache: "charName:monsterCode" → { loadout, simResult, level }
const _gearCache = new Map();

/**
 * Equip optimal gear for fighting a specific monster.
 * Uses simulation-based optimizer, then performs only necessary equip swaps.
 * Caches results to avoid re-optimizing for the same target at the same level.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @returns {Promise<{ changed: boolean, simResult: object | null, ready: boolean }>}
 */
export async function equipForCombat(ctx, monsterCode) {
  const cacheKey = `${ctx.name}:${monsterCode}`;

  // Check cache — skip if same monster, same level, same gear
  const cached = _gearCache.get(cacheKey);
  if (cached && cached.level === ctx.get().level) {
    let gearMatches = true;
    for (const slot of EQUIPMENT_SLOTS) {
      const current = ctx.get()[`${slot}_slot`] || null;
      const expected = cached.loadout.get(slot) || null;
      if (current !== expected) { gearMatches = false; break; }
    }
    if (gearMatches) {
      return { changed: false, simResult: cached.simResult, ready: true };
    }
  }

  const result = await optimizeForMonster(ctx, monsterCode);
  if (!result) return { changed: false, simResult: null, ready: false };

  const { loadout, simResult } = result;

  const { changed, swapsFailed, missingSlots } = await applyGearLoadout(ctx, loadout, {
    reason: `combat gear for ${monsterCode}`,
    abortOnMissing: true,
  });

  if (!changed && missingSlots.length > 0) {
    _gearCache.delete(cacheKey);
    log.error(`[${ctx.name}] Combat gear not ready for ${monsterCode}; missing ${missingSlots.join(', ')}`);
    return { changed: false, simResult, ready: false };
  }

  if (!changed) {
    // No slots needed changing (applyGearLoadout found 0 changes)
    _gearCache.set(cacheKey, { loadout, simResult, level: ctx.get().level });
    return { changed: false, simResult, ready: true };
  }

  if (!swapsFailed) {
    _gearCache.set(cacheKey, { loadout, simResult, level: ctx.get().level });
  } else {
    _gearCache.delete(cacheKey);
  }
  return { changed: true, simResult, ready: !swapsFailed };
}

/** Clear the gear cache for a character (e.g., on level-up). */
export function clearGearCache(charName) {
  for (const key of _gearCache.keys()) {
    if (key.startsWith(`${charName}:`)) _gearCache.delete(key);
  }
  for (const key of _gatheringGearCache.keys()) {
    if (key.startsWith(`${charName}:`)) _gatheringGearCache.delete(key);
  }
}

// ── gathering gear optimization ──────────────────────────────────────

// Cache: "charName:skill" → { loadout, level }
const _gatheringGearCache = new Map();
const GATHER_NO_TOOL_RECHECK_MS = 30_000;

function currentGatherLoadout(ctx) {
  const loadout = new Map();
  const char = ctx.get();
  for (const slot of EQUIPMENT_SLOTS) {
    loadout.set(slot, char[`${slot}_slot`] || null);
  }
  return loadout;
}

/**
 * Equip optimal gear for gathering a specific skill.
 * Selects the correct tool (weapon) and maximizes prospecting on all other slots.
 * Caches results to avoid re-optimizing for the same skill at the same level.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} skill — gathering skill name (mining, woodcutting, fishing, alchemy)
 * @returns {Promise<{ changed: boolean }>}
 */
export async function equipForGathering(ctx, skill) {
  const cacheKey = `${ctx.name}:${skill}`;

  // Check cache — skip if same skill, same level, same gear
  const cached = _gatheringGearCache.get(cacheKey);
  if (cached && cached.level === ctx.get().level) {
    if (cached.missingTool === true) {
      const nextCheckAtMs = Number(cached.nextCheckAtMs) || 0;
      if (Date.now() < nextCheckAtMs) {
        return {
          changed: false,
          missingToolCode: cached.missingToolCode || null,
          orderQueued: false,
          proceedWithoutTool: true,
        };
      }
    }

    let gearMatches = true;
    for (const slot of EQUIPMENT_SLOTS) {
      const current = ctx.get()[`${slot}_slot`] || null;
      const expected = cached.loadout.get(slot) || null;
      if (current !== expected) { gearMatches = false; break; }
    }
    if (gearMatches) {
      return { changed: false };
    }
  }

  const result = await optimizeForGathering(ctx, skill);
  if (!result) {
    const order = ensureMissingGatherToolOrder(ctx, skill);
    _gatheringGearCache.set(cacheKey, {
      loadout: currentGatherLoadout(ctx),
      level: ctx.get().level,
      missingTool: true,
      missingToolCode: order?.toolCode || null,
      nextCheckAtMs: Date.now() + GATHER_NO_TOOL_RECHECK_MS,
    });
    log.info(`[${ctx.name}] Gathering gear: proceeding without ${skill} tool (recheck in ${Math.round(GATHER_NO_TOOL_RECHECK_MS / 1000)}s)`);
    return {
      changed: false,
      missingToolCode: order?.toolCode || null,
      orderQueued: order?.queued === true,
      proceedWithoutTool: true,
    };
  }

  const { loadout } = result;

  const { changed, swapsFailed } = await applyGearLoadout(ctx, loadout, {
    reason: `gathering gear for ${skill}`,
  });

  if (!changed) {
    _gatheringGearCache.set(cacheKey, { loadout, level: ctx.get().level });
    return { changed: false };
  }

  if (!swapsFailed) {
    _gatheringGearCache.set(cacheKey, { loadout, level: ctx.get().level, missingTool: false });
  } else {
    _gatheringGearCache.delete(cacheKey);
  }
  return { changed: true };
}
