/**
 * Reusable action patterns.
 * Every helper takes a CharacterContext as first arg and handles
 * waitForCooldown + ctx.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as log from './log.mjs';
import {
  depositAllInventory,
  withdrawBankItem,
  withdrawBankItems,
} from './services/bank-ops.mjs';
import { logWithdrawalWarnings } from './utils.mjs';

/** Error thrown when the API returns 595 — no path to destination. */
export class NoPathError extends Error {
  constructor(x, y, originalMessage) {
    super(`No path available to (${x},${y})`);
    this.name = 'NoPathError';
    this.x = x;
    this.y = y;
    this.originalMessage = originalMessage;
  }
}

/** Move to (x,y) if not already there. No-ops if already at target. */
export async function moveTo(ctx, x, y) {
  if (ctx.isAt(x, y)) return null;

  const c = ctx.get();
  log.info(`[${ctx.name}] Moving (${c.x},${c.y}) → (${x},${y})`);
  try {
    const result = await api.move(x, y, ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    return result;
  } catch (err) {
    if (err.code === 595) {
      log.warn(`[${ctx.name}] No path to (${x},${y}): ${err.message}`);
      throw new NoPathError(x, y, err.message);
    }
    throw err;
  }
}

// Re-export food/healing functions for backward compatibility.
// New code should import directly from './services/food-manager.mjs'.
export {
  hasHealingFood,
  canUseRestAction,
  restUntil,
  restBeforeFight,
  withdrawFoodForFights,
} from './services/food-manager.mjs';

/** Single fight. Returns the full action result. */
export async function fightOnce(ctx) {
  const result = await api.fight(ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  return result;
}

/** Single gather. Returns the full action result. */
export async function gatherOnce(ctx) {
  const result = await api.gather(ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  return result;
}

/**
 * Swap equipment in a slot: unequip current (if any), equip new item.
 * Caller must ensure newItemCode is in inventory.
 * Returns { unequipped } — the code that was removed, or null.
 */
export async function swapEquipment(ctx, slot, newItemCode) {
  const currentCode = ctx.get()[`${slot}_slot`] || null;

  if (currentCode) {
    if (ctx.inventoryFull()) {
      throw new Error(`Inventory full, cannot unequip ${slot}`);
    }
    log.info(`[${ctx.name}] Unequipping ${currentCode} from ${slot}`);
    const ur = await api.unequipItem(slot, ctx.name);
    await api.waitForCooldown(ur);
    await ctx.refresh();
  }

  try {
    log.info(`[${ctx.name}] Equipping ${newItemCode} in ${slot}`);
    const er = await api.equipItem(slot, newItemCode, ctx.name);
    await api.waitForCooldown(er);
    await ctx.refresh();
  } catch (err) {
    if (currentCode) {
      log.warn(`[${ctx.name}] Equip ${newItemCode} failed, rolling back to ${currentCode}`);
      try {
        const rr = await api.equipItem(slot, currentCode, ctx.name);
        await api.waitForCooldown(rr);
        await ctx.refresh();
      } catch (rollbackErr) {
        log.warn(`[${ctx.name}] Rollback failed for ${slot}: ${rollbackErr.message}`);
      }
    }
    throw err;
  }

  return { unequipped: currentCode };
}

/**
 * Extract structured results from a fight action response.
 * @returns {{ win: boolean, turns: number, xp: number, gold: number,
 *             drops: string, dropsRaw: Array, finalHp: number }}
 */
export function parseFightResult(result, ctx) {
  const f = result.fight;
  const cr = f.characters?.find(ch => ch.character_name === ctx.name)
          || f.characters?.[0] || {};
  return {
    win: f.result === 'win',
    turns: f.turns,
    xp: cr.xp || 0,
    gold: cr.gold || 0,
    drops: cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '',
    dropsRaw: cr.drops || [],
    finalHp: cr.final_hp || 0,
  };
}

/**
 * Compute how much of a raw material is still needed for a production plan,
 * accounting for intermediates already crafted.
 */
export function rawMaterialNeeded(ctx, plan, itemCode, batchSize = 1) {
  let total = 0;
  let usedByCraft = false;

  for (const step of plan) {
    if (step.type !== 'craft') continue;
    for (const mat of step.recipe.items) {
      if (mat.code !== itemCode) continue;
      usedByCraft = true;
      const isFinalStep = step === plan[plan.length - 1];
      const remaining = isFinalStep
        ? batchSize
        : Math.max(0, step.quantity * batchSize - ctx.itemCount(step.itemCode));
      total += remaining * mat.quantity;
    }
  }

  if (!usedByCraft) {
    const gatherStep = plan.find(s => s.type === 'gather' && s.itemCode === itemCode);
    return gatherStep ? gatherStep.quantity * batchSize : 0;
  }

  return total;
}

/**
 * Withdraw items from bank for a production plan.
 * Checks steps in reverse order (highest-value intermediates first).
 * @param {object} ctx — CharacterContext
 * @param {Array} plan — array of { itemCode, quantity, ... } steps
 * @param {object} opts
 * @param {string[]} opts.excludeCodes - item codes to skip during withdrawal planning
 * @param {number} opts.maxUnits - optional cap for total units to withdraw
 * @returns {string[]} — list of "itemCode xN" descriptions for logging
 */
export async function withdrawPlanFromBank(ctx, plan, batchSize = 1, opts = {}) {
  const withdrawn = [];
  const excluded = new Set(opts.excludeCodes || []);
  const parsedMaxUnits = Number(opts.maxUnits);
  const maxUnits = Number.isFinite(parsedMaxUnits) && parsedMaxUnits >= 0
    ? Math.floor(parsedMaxUnits)
    : null;
  const stepsReversed = [...plan].reverse();

  const plannedByCode = new Map();
  let remainingSpace = Math.max(0, ctx.inventoryCapacity() - ctx.inventoryCount());
  if (maxUnits !== null) {
    remainingSpace = Math.min(remainingSpace, maxUnits);
  }

  for (const step of stepsReversed) {
    if (remainingSpace <= 0) break;

    const code = step.itemCode;
    if (excluded.has(code)) continue;

    const plannedQty = plannedByCode.get(code) || 0;
    const have = ctx.itemCount(code) + plannedQty;
    const needed = step.quantity * batchSize - have;
    if (needed <= 0) continue;

    const toWithdraw = Math.min(needed, remainingSpace);
    if (toWithdraw <= 0) continue;

    plannedByCode.set(code, plannedQty + toWithdraw);
    remainingSpace -= toWithdraw;
  }

  const requests = [...plannedByCode.entries()].map(([code, qty]) => ({ code, qty }));
  if (requests.length === 0) return withdrawn;

  const result = await withdrawBankItems(ctx, requests, {
    reason: 'helper withdrawPlanFromBank',
    mode: 'partial',
    retryStaleOnce: true,
  });
  for (const row of result.withdrawn) {
    withdrawn.push(`${row.code} x${row.quantity}`);
  }
  logWithdrawalWarnings(ctx, result);

  return withdrawn;
}

/** Move to bank and withdraw a specific item. */
export async function withdrawItem(ctx, code, quantity = 1, opts = {}) {
  return withdrawBankItem(ctx, code, quantity, {
    reason: opts.reason || 'helper withdrawItem',
    mode: 'partial',
    retryStaleOnce: true,
    throwOnAllSkipped: true,
  });
}

/** Move to bank and deposit all inventory items. */
export async function depositAll(ctx, opts = {}) {
  await depositAllInventory(ctx, {
    reason: opts.reason || 'helper depositAll',
    keepByCode: opts.keepByCode || {},
  });
}

// Re-export gear loadout functions for backward compatibility.
// New code should import directly from './services/gear-loadout.mjs'.
export { equipForCombat, equipForGathering, clearGearCache } from './services/gear-loadout.mjs';
