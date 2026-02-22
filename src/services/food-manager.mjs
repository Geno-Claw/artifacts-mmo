/**
 * Food & healing management — scoring, eating, bank withdrawal for fights.
 *
 * Extracted from helpers.mjs. Pure food/healing logic with no gear concerns.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { canUseItem } from './item-conditions.mjs';
import { hpNeededForFight, simulateCombat } from './combat-simulator.mjs';
import { withdrawBankItems } from './bank-ops.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';

// ── helpers ──────────────────────────────────────────────────────────

function isConditionNotMet(err) {
  const msg = `${err?.message || ''}`.toLowerCase();
  return msg.includes('condition not met');
}

/**
 * Score and filter healing items from a list of { code, quantity } entries.
 * Returns items sorted by potency (most potent first).
 */
function scoreHealingItems(entries, character) {
  const foods = [];
  for (const { code, quantity } of entries) {
    if (!code || quantity <= 0) continue;

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

/** Find consumable food items in inventory that restore HP. */
function findHealingFood(ctx) {
  const character = ctx.get();
  const inv = character.inventory;
  if (!inv) return [];
  return scoreHealingItems(inv, character);
}

/** Find consumable food items in the bank that restore HP. */
function findBankFood(bankItems, character) {
  const entries = [];
  for (const [code, quantity] of bankItems) {
    entries.push({ code, quantity });
  }
  return scoreHealingItems(entries, character);
}

// ── exports ──────────────────────────────────────────────────────────

/** True if character has at least one usable healing consumable in inventory. */
export function hasHealingFood(ctx) {
  return findHealingFood(ctx).length > 0;
}

/** Rest action is always available (no level requirement). */
export function canUseRestAction() {
  return true;
}

/** Rest until HP reaches the given percentage. Eats food first for faster recovery. Returns true when target HP is reached. */
export async function restUntil(ctx, hpPct = 80) {
  // Phase 1: Eat food from inventory
  const foods = findHealingFood(ctx);
  for (const food of foods) {
    if (api.isShuttingDown()) return false;
    if (ctx.hpPercent() >= hpPct) return true;

    const c = ctx.get();
    const hpNeeded = Math.ceil(c.max_hp * hpPct / 100) - c.hp;
    const countNeeded = Math.ceil(hpNeeded / food.hpRestore);
    const countToEat = Math.min(countNeeded, food.quantity);
    if (countToEat <= 0) continue;

    log.info(`[${ctx.name}] Eating ${food.code} x${countToEat} (+${food.hpRestore}hp each)`);
    try {
      const result = await api.useItem(food.code, countToEat, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
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

  // Phase 2: Fall back to rest API for remaining HP deficit
  let restRetries = 0;
  const MAX_REST_RETRIES = 3;
  while (ctx.hpPercent() < hpPct && !api.isShuttingDown()) {
    const c = ctx.get();
    log.info(`[${ctx.name}] Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`);
    try {
      const result = await api.rest(ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
      restRetries = 0;
    } catch (err) {
      if (isConditionNotMet(err)) {
        restRetries++;
        if (restRetries >= MAX_REST_RETRIES) {
          log.warn(`[${ctx.name}] Rest failed ${MAX_REST_RETRIES} times (${err.message}); giving up`);
          return false;
        }
        log.warn(`[${ctx.name}] Rest unavailable (${err.message}), retry ${restRetries}/${MAX_REST_RETRIES}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
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
 * @param {import('../context.mjs').CharacterContext} ctx
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
  logWithdrawalWarnings(ctx, withdrawalResult, 'Food');

  return true;
}
