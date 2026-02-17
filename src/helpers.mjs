/**
 * Reusable action patterns.
 * Every helper takes a CharacterContext as first arg and handles
 * waitForCooldown + ctx.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as log from './log.mjs';
import * as gameData from './services/game-data.mjs';
import { EQUIPMENT_SLOTS } from './services/game-data.mjs';
import { hpNeededForFight } from './services/combat-simulator.mjs';
import { optimizeForMonster } from './services/gear-optimizer.mjs';
import { BANK } from './data/locations.mjs';

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
  const inv = ctx.get().inventory;
  if (!inv) return [];

  const foods = [];
  for (const slot of inv) {
    if (!slot.code || slot.quantity <= 0) continue;

    const item = gameData.getItem(slot.code);
    if (!item || item.type !== 'consumable') continue;
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

/** Rest until HP reaches the given percentage. Eats food first for faster recovery. */
export async function restUntil(ctx, hpPct = 80) {
  // Phase 1: Eat food from inventory
  const foods = findHealingFood(ctx);
  for (const food of foods) {
    if (ctx.hpPercent() >= hpPct) return;

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
      throw err;
    }
  }

  // Phase 2: Fall back to rest API for remaining HP deficit
  while (ctx.hpPercent() < hpPct) {
    const c = ctx.get();
    log.info(`[${ctx.name}] Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`);
    const result = await api.rest(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
  }
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
  await restUntil(ctx, targetPct);
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

  log.info(`[${ctx.name}] Equipping ${newItemCode} in ${slot}`);
  const er = await api.equipItem(slot, newItemCode, ctx.name);
  await api.waitForCooldown(er);
  await ctx.refresh();

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
 * @returns {string[]} — list of "itemCode xN" descriptions for logging
 */
export async function withdrawPlanFromBank(ctx, plan, batchSize = 1) {
  const bank = await gameData.getBankItems(true);
  const withdrawn = [];

  const stepsReversed = [...plan].reverse();
  for (const step of stepsReversed) {
    if (ctx.inventoryFull()) break;

    const have = ctx.itemCount(step.itemCode);
    const needed = step.quantity * batchSize - have;
    if (needed <= 0) continue;

    const inBank = bank.get(step.itemCode) || 0;
    if (inBank <= 0) continue;

    const space = ctx.inventoryCapacity() - ctx.inventoryCount();
    const toWithdraw = Math.min(needed, inBank, space);
    if (toWithdraw <= 0) continue;

    try {
      await withdrawItem(ctx, step.itemCode, toWithdraw);
      withdrawn.push(`${step.itemCode} x${toWithdraw}`);
    } catch (err) {
      log.warn(`[${ctx.name}] Could not withdraw ${step.itemCode}: ${err.message}`);
    }
  }

  return withdrawn;
}

/** Move to bank and withdraw a specific item. */
export async function withdrawItem(ctx, code, quantity = 1) {
  await moveTo(ctx, BANK.x, BANK.y);
  log.info(`[${ctx.name}] Withdrawing ${code} x${quantity}`);
  const result = await api.withdrawBank([{ code, quantity }], ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  return result;
}

/** Move to bank and deposit all inventory items. */
export async function depositAll(ctx) {
  await moveTo(ctx, BANK.x, BANK.y);
  const items = ctx.get().inventory
    .filter(slot => slot.code)
    .map(slot => ({ code: slot.code, quantity: slot.quantity }));
  if (items.length === 0) return;
  log.info(`[${ctx.name}] Depositing ${items.length} item(s): ${items.map(i => `${i.code} x${i.quantity}`).join(', ')}`);
  const result = await api.depositBank(items, ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
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
 * @returns {Promise<{ changed: boolean, simResult: object | null }>}
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
      return { changed: false, simResult: cached.simResult };
    }
  }

  const result = await optimizeForMonster(ctx, monsterCode);
  if (!result) return { changed: false, simResult: null };

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
    return { changed: false, simResult };
  }

  log.info(`[${ctx.name}] Gear optimizer: ${changes.length} slot(s) to change for ${monsterCode}`);

  // Determine if any items need to come from bank
  const bankNeeded = changes.filter(c =>
    c.targetCode
    && !ctx.hasItem(c.targetCode)
    && ctx.get()[`${c.slot}_slot`] !== c.targetCode
  );

  if (bankNeeded.length > 0) {
    // Ensure inventory space for swaps
    const slotsNeedingUnequip = changes.filter(c => c.currentCode && c.targetCode).length;
    if (ctx.inventoryCount() + slotsNeedingUnequip >= ctx.inventoryCapacity()) {
      await depositAll(ctx);
    }

    for (const { targetCode } of bankNeeded) {
      if (ctx.hasItem(targetCode)) continue;
      try {
        await withdrawItem(ctx, targetCode, 1);
      } catch (err) {
        log.warn(`[${ctx.name}] Could not withdraw ${targetCode}: ${err.message}`);
      }
    }
  }

  // Perform equipment swaps
  for (const { slot, currentCode, targetCode } of changes) {
    if (targetCode === null) {
      // Unequip only
      if (currentCode) {
        if (ctx.inventoryFull()) {
          log.warn(`[${ctx.name}] Inventory full, cannot unequip ${slot}`);
          continue;
        }
        log.info(`[${ctx.name}] Unequipping ${currentCode} from ${slot}`);
        const ur = await api.unequipItem(slot, ctx.name);
        await api.waitForCooldown(ur);
        await ctx.refresh();
      }
    } else {
      try {
        await swapEquipment(ctx, slot, targetCode);
      } catch (err) {
        log.warn(`[${ctx.name}] Gear swap failed for ${slot}: ${err.message}`);
      }
    }
  }

  // Deposit old gear to bank if we made a bank trip
  if (bankNeeded.length > 0) {
    const unequippedCodes = changes
      .filter(c => c.currentCode && c.currentCode !== c.targetCode)
      .map(c => c.currentCode)
      .filter(code => ctx.hasItem(code));

    if (unequippedCodes.length > 0) {
      await moveTo(ctx, BANK.x, BANK.y);
      const items = unequippedCodes.map(code => ({ code, quantity: ctx.itemCount(code) }));
      try {
        const dr = await api.depositBank(items, ctx.name);
        await api.waitForCooldown(dr);
        await ctx.refresh();
      } catch (err) {
        log.warn(`[${ctx.name}] Could not deposit old gear: ${err.message}`);
      }
    }
  }

  _gearCache.set(cacheKey, { loadout, simResult, level: ctx.get().level });
  return { changed: true, simResult };
}

/** Clear the gear cache for a character (e.g., on level-up). */
export function clearGearCache(charName) {
  for (const key of _gearCache.keys()) {
    if (key.startsWith(`${charName}:`)) _gearCache.delete(key);
  }
}
