/**
 * Reusable action patterns.
 * Every helper takes a CharacterContext as first arg and handles
 * waitForCooldown + ctx.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as log from './log.mjs';
import * as gameData from './services/game-data.mjs';
import { canUseItem } from './services/item-conditions.mjs';
import { EQUIPMENT_SLOTS } from './services/game-data.mjs';
import { hpNeededForFight, simulateCombat } from './services/combat-simulator.mjs';
import { optimizeForMonster, optimizeForGathering } from './services/gear-optimizer.mjs';
import { ensureMissingGatherToolOrder } from './services/tool-policy.mjs';
import {
  depositAllInventory,
  depositBankItems,
  withdrawBankItem,
  withdrawBankItems,
} from './services/bank-ops.mjs';
import { getOwnedKeepByCodeForInventory } from './services/gear-state.mjs';

/** Move to (x,y) if not already there. No-ops if already at target. */
export async function moveTo(ctx, x, y) {
  if (ctx.isAt(x, y)) return null;

  const c = ctx.get();
  log.info(`[${ctx.name}] Moving (${c.x},${c.y}) → (${x},${y})`);
  const result = await api.move(x, y, ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  return result;
}

/** Find consumable food items in inventory that restore HP. */
function findHealingFood(ctx) {
  const character = ctx.get();
  const inv = character.inventory;
  if (!inv) return [];

  const foods = [];
  for (const slot of inv) {
    if (!slot.code || slot.quantity <= 0) continue;

    const item = gameData.getItem(slot.code);
    if (!item || item.type !== 'consumable') continue;
    if (!canUseItem(item, character)) continue;
    if (!item.effects || item.effects.length === 0) continue;

    let hpRestore = 0;
    for (const effect of item.effects) {
      const name = effect.name || effect.code || '';
      if (name === 'hp' || name === 'heal' || name === 'restore' || name === 'restore_hp') {
        hpRestore += (effect.value || 0);
      }
    }
    if (hpRestore <= 0) continue;

    foods.push({ code: slot.code, quantity: slot.quantity, hpRestore });
  }

  // Eat the most potent food first
  foods.sort((a, b) => b.hpRestore - a.hpRestore);
  return foods;
}

/** True if character has at least one usable healing consumable in inventory. */
export function hasHealingFood(ctx) {
  return findHealingFood(ctx).length > 0;
}

/** Rest action availability (server-side requires level > 4). */
export function canUseRestAction(ctx) {
  return (ctx.get().level || 0) > 4;
}

function isConditionNotMet(err) {
  const msg = `${err?.message || ''}`.toLowerCase();
  return msg.includes('condition not met');
}

/** Find consumable food items in the bank that restore HP. */
function findBankFood(bankItems, character) {
  const foods = [];
  for (const [code, quantity] of bankItems) {
    if (quantity <= 0) continue;

    const item = gameData.getItem(code);
    if (!item || item.type !== 'consumable') continue;
    if (!canUseItem(item, character)) continue;
    if (!item.effects || item.effects.length === 0) continue;

    let hpRestore = 0;
    for (const effect of item.effects) {
      const name = effect.name || effect.code || '';
      if (name === 'hp' || name === 'heal' || name === 'restore' || name === 'restore_hp') {
        hpRestore += (effect.value || 0);
      }
    }
    if (hpRestore <= 0) continue;

    foods.push({ code, quantity, hpRestore });
  }

  foods.sort((a, b) => b.hpRestore - a.hpRestore);
  return foods;
}

/** Rest until HP reaches the given percentage. Eats food first for faster recovery. Returns true when target HP is reached. */
export async function restUntil(ctx, hpPct = 80) {
  // Phase 1: Eat food from inventory
  const foods = findHealingFood(ctx);
  for (const food of foods) {
    if (ctx.hpPercent() >= hpPct) return true;

    const c = ctx.get();
    const hpNeeded = Math.ceil(c.max_hp * hpPct / 100) - c.hp;
    const countNeeded = Math.ceil(hpNeeded / food.hpRestore);
    const countToEat = Math.min(countNeeded, food.quantity);
    if (countToEat <= 0) continue;

    log.info(`[${ctx.name}] Eating ${food.code} x${countToEat} (+${food.hpRestore}hp each)`);
    try {
      const result = await api.useItem(food.code, countToEat, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
    } catch (err) {
      if (err.code === 476) {
        log.warn(`[${ctx.name}] ${food.code} is not consumable, skipping`);
        continue;
      }
      if (isConditionNotMet(err)) {
        log.warn(`[${ctx.name}] Cannot use ${food.code} right now (${err.message}), skipping`);
        continue;
      }
      throw err;
    }
  }

  if (ctx.hpPercent() >= hpPct) return true;
  if (!canUseRestAction(ctx)) {
    const c = ctx.get();
    log.warn(`[${ctx.name}] Rest unavailable below level 5 (lv${c.level}); cannot heal to ${hpPct}%`);
    return false;
  }

  // Phase 2: Fall back to rest API for remaining HP deficit
  while (ctx.hpPercent() < hpPct) {
    const c = ctx.get();
    log.info(`[${ctx.name}] Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`);
    try {
      const result = await api.rest(ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
    } catch (err) {
      if (isConditionNotMet(err)) {
        log.warn(`[${ctx.name}] Rest unavailable right now (${err.message}); stopping rest attempts`);
        return false;
      }
      throw err;
    }
  }
  return true;
}

/**
 * Rest inline if current HP is too low to survive fighting the given monster.
 * Returns true if ready to fight, false if the monster is unbeatable.
 */
export async function restBeforeFight(ctx, monsterCode) {
  const minHp = hpNeededForFight(ctx, monsterCode);
  if (minHp === null) return false;

  const c = ctx.get();
  if (c.hp >= minHp) return true;

  const targetPct = Math.ceil((minHp / c.max_hp) * 100);
  log.info(`[${ctx.name}] Need ${minHp}hp (${targetPct}%) to fight ${monsterCode}, have ${c.hp}hp`);
  const recovered = await restUntil(ctx, targetPct);
  if (!recovered) {
    const fresh = ctx.get();
    if (fresh.hp < minHp) {
      log.warn(`[${ctx.name}] Cannot reach ${minHp}hp for ${monsterCode} (have ${fresh.hp}hp)`);
      return false;
    }
  }
  return ctx.get().hp >= minHp;
}

/**
 * Withdraw enough healing food from the bank for N fights against a monster.
 * Uses the combat simulator to calculate exact total healing needed, then
 * withdraws the minimum food to cover it. If the bank doesn't have enough,
 * takes what's available — restBeforeFight() handles the remainder via rest API.
 *
 * Called once at the start of a combat routine, not every fight.
 *
 * @param {import('./context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @param {number} numFights — total fights planned
 * @returns {Promise<boolean>} true if ready (even if no food), false if unbeatable
 */
export async function withdrawFoodForFights(ctx, monsterCode, numFights) {
  if (numFights <= 0) return true;

  const monster = gameData.getMonster(monsterCode);
  if (!monster) return false;

  const charStats = ctx.get();
  const result = simulateCombat(charStats, monster);
  if (!result.win) return false;

  const damageTaken = charStats.max_hp - result.remainingHp;
  const totalHealingNeeded = Math.max(0, damageTaken * numFights - (charStats.max_hp - 1));

  if (totalHealingNeeded <= 0) {
    log.info(`[${ctx.name}] Food: no healing needed for ${numFights} fights vs ${monsterCode}`);
    return true;
  }

  // Subtract healing from food already in inventory
  const inventoryFoods = findHealingFood(ctx);
  let inventoryHealing = 0;
  for (const food of inventoryFoods) {
    inventoryHealing += food.hpRestore * food.quantity;
  }

  const healingDeficit = totalHealingNeeded - inventoryHealing;
  if (healingDeficit <= 0) {
    log.info(`[${ctx.name}] Food: inventory already covers ${numFights} fights vs ${monsterCode}`);
    return true;
  }

  // Find food in bank
  const bank = await gameData.getBankItems(true);
  const bankFoods = findBankFood(bank, ctx.get());
  if (bankFoods.length === 0) {
    log.info(`[${ctx.name}] Food: no usable food in bank, will rely on rest API`);
    return true;
  }

  // Greedily pick most potent food first (minimizes item count)
  const toWithdraw = [];
  let remainingHealing = healingDeficit;

  for (const food of bankFoods) {
    if (remainingHealing <= 0) break;
    const countNeeded = Math.ceil(remainingHealing / food.hpRestore);
    const count = Math.min(countNeeded, food.quantity);
    if (count <= 0) continue;
    toWithdraw.push({ code: food.code, quantity: count });
    remainingHealing -= count * food.hpRestore;
  }

  if (toWithdraw.length === 0) return true;

  // Cap by available inventory space
  let totalCount = toWithdraw.reduce((sum, w) => sum + w.quantity, 0);
  const space = ctx.inventoryCapacity() - ctx.inventoryCount();
  if (totalCount > space && space > 0) {
    const scale = space / totalCount;
    for (const w of toWithdraw) {
      w.quantity = Math.max(1, Math.floor(w.quantity * scale));
    }
  } else if (space <= 0) {
    log.info(`[${ctx.name}] Food: no inventory space for food`);
    return true;
  }

  // Withdraw from bank (bank-ops handles travel to the nearest accessible bank)
  for (const w of toWithdraw) {
    if (w.quantity <= 0) continue;
    log.info(`[${ctx.name}] Food: withdrawing ${w.code} x${w.quantity} for ${numFights} fights vs ${monsterCode}`);
  }
  const withdrawalResult = await withdrawBankItems(ctx, toWithdraw, {
    reason: `food withdrawal for ${monsterCode}`,
    mode: 'partial',
    retryStaleOnce: true,
  });
  for (const row of withdrawalResult.failed) {
    log.warn(`[${ctx.name}] Food: could not withdraw ${row.code}: ${row.error}`);
  }
  for (const row of withdrawalResult.skipped) {
    log.warn(`[${ctx.name}] Food: skipped ${row.code} (${row.reason})`);
  }

  return true;
}

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
 * @returns {string[]} — list of "itemCode xN" descriptions for logging
 */
export async function withdrawPlanFromBank(ctx, plan, batchSize = 1, opts = {}) {
  const withdrawn = [];
  const excluded = new Set(opts.excludeCodes || []);
  const stepsReversed = [...plan].reverse();

  const plannedByCode = new Map();
  let remainingSpace = ctx.inventoryCapacity() - ctx.inventoryCount();

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
  for (const row of result.failed) {
    log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.error}`);
  }
  for (const row of result.skipped) {
    if (!row.reason.startsWith('partial fill')) {
      log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.reason}`);
    }
  }

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

// --- Combat gear optimization ---

// Cache: "charName:monsterCode" → { loadout, simResult, level }
const _gearCache = new Map();

/**
 * Equip optimal gear for fighting a specific monster.
 * Uses simulation-based optimizer, then performs only necessary equip swaps.
 * Caches results to avoid re-optimizing for the same target at the same level.
 *
 * @param {import('./context.mjs').CharacterContext} ctx
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
    _gearCache.set(cacheKey, { loadout, simResult, level: ctx.get().level });
    return { changed: false, simResult, ready: true };
  }

  log.info(`[${ctx.name}] Gear optimizer: ${changes.length} slot(s) to change for ${monsterCode}`);

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
    // Ensure inventory space for swaps
    const slotsNeedingUnequip = changes.filter(c => c.currentCode && c.targetCode).length;
    if (ctx.inventoryCount() + slotsNeedingUnequip >= ctx.inventoryCapacity()) {
      await depositAll(ctx, { keepByCode: getOwnedKeepByCodeForInventory(ctx) });
    }

    const requests = [...bankNeeded.entries()].map(([code, qty]) => ({ code, qty }));
    const result = await withdrawBankItems(ctx, requests, {
      reason: `combat gear withdrawal for ${monsterCode}`,
      mode: 'partial',
      retryStaleOnce: true,
    });
    for (const row of result.failed) {
      log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.error}`);
    }
    for (const row of result.skipped) {
      if (!row.reason.startsWith('partial fill')) {
        log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.reason}`);
      }
    }
  }

  const missingSlots = [];
  for (const { slot, targetCode } of changes) {
    if (!targetCode) continue;
    if (!ctx.hasItem(targetCode) && ctx.get()[`${slot}_slot`] !== targetCode) {
      missingSlots.push(`${slot}:${targetCode}`);
    }
  }
  if (missingSlots.length > 0) {
    _gearCache.delete(cacheKey);
    log.error(`[${ctx.name}] Combat gear not ready for ${monsterCode}; missing ${missingSlots.join(', ')}`);
    return { changed: false, simResult, ready: false };
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
        await api.waitForCooldown(ur);
        await ctx.refresh();
      }
    } else {
      // Verify target item is available before attempting swap
      if (!ctx.hasItem(targetCode) && ctx.get()[`${slot}_slot`] !== targetCode) {
        log.warn(`[${ctx.name}] Skipping ${slot} swap: ${targetCode} not in inventory (withdrawal failed?)`);
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
          await depositBankItems(ctx, items, { reason: 'combat gear cleanup deposit' });
        } catch (err) {
          log.warn(`[${ctx.name}] Could not deposit old gear: ${err.message}`);
        }
      }
    }
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

// --- Gathering gear optimization ---

// Cache: "charName:skill" → { loadout, level }
const _gatheringGearCache = new Map();

/**
 * Equip optimal gear for gathering a specific skill.
 * Selects the correct tool (weapon) and maximizes prospecting on all other slots.
 * Caches results to avoid re-optimizing for the same skill at the same level.
 *
 * @param {import('./context.mjs').CharacterContext} ctx
 * @param {string} skill — gathering skill name (mining, woodcutting, fishing, alchemy)
 * @returns {Promise<{ changed: boolean }>}
 */
export async function equipForGathering(ctx, skill) {
  const cacheKey = `${ctx.name}:${skill}`;

  // Check cache — skip if same skill, same level, same gear
  const cached = _gatheringGearCache.get(cacheKey);
  if (cached && cached.level === ctx.get().level) {
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
    return {
      changed: false,
      missingToolCode: order?.toolCode || null,
      orderQueued: order?.queued === true,
    };
  }

  const { loadout } = result;

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
    _gatheringGearCache.set(cacheKey, { loadout, level: ctx.get().level });
    return { changed: false };
  }

  log.info(`[${ctx.name}] Gathering gear: ${changes.length} slot(s) to change for ${skill}`);

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
    const slotsNeedingUnequip = changes.filter(c => c.currentCode && c.targetCode).length;
    if (ctx.inventoryCount() + slotsNeedingUnequip >= ctx.inventoryCapacity()) {
      await depositAll(ctx, { keepByCode: getOwnedKeepByCodeForInventory(ctx) });
    }

    const requests = [...bankNeeded.entries()].map(([code, qty]) => ({ code, qty }));
    const result = await withdrawBankItems(ctx, requests, {
      reason: `gathering gear withdrawal for ${skill}`,
      mode: 'partial',
      retryStaleOnce: true,
    });
    for (const row of result.failed) {
      log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.error}`);
    }
    for (const row of result.skipped) {
      if (!row.reason.startsWith('partial fill')) {
        log.warn(`[${ctx.name}] Could not withdraw ${row.code}: ${row.reason}`);
      }
    }
  }

  // Perform equipment swaps
  let swapsFailed = false;
  for (const { slot, currentCode, targetCode } of changes) {
    if (targetCode === null) {
      if (currentCode) {
        if (ctx.inventoryFull()) {
          log.warn(`[${ctx.name}] Inventory full, cannot unequip ${slot}`);
          swapsFailed = true;
          continue;
        }
        log.info(`[${ctx.name}] Unequipping ${currentCode} from ${slot}`);
        const ur = await api.unequipItem(slot, ctx.name);
        await api.waitForCooldown(ur);
        await ctx.refresh();
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
          await depositBankItems(ctx, items, { reason: 'gathering gear cleanup deposit' });
        } catch (err) {
          log.warn(`[${ctx.name}] Could not deposit old gear: ${err.message}`);
        }
      }
    }
  }

  if (!swapsFailed) {
    _gatheringGearCache.set(cacheKey, { loadout, level: ctx.get().level });
  } else {
    _gatheringGearCache.delete(cacheKey);
  }
  return { changed: true };
}
