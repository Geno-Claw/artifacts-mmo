/**
 * Food & healing management — scoring, eating, bank withdrawal for fights.
 *
 * Extracted from helpers.mjs. Pure food/healing logic with no gear concerns.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { canUseItem } from './item-conditions.mjs';
import { buildEquippedSimOptions, hpNeededForFight, simulateCombat } from './combat-simulator.mjs';
import { withdrawBankItems } from './bank-ops.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';

const foodLog = log.createLogger({ scope: 'service.food' });

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

    foodLog.info(`[${ctx.name}] Eating ${food.code} x${countToEat} (+${food.hpRestore}hp each)`, {
      event: 'food.consume.start',
      context: {
        character: ctx.name,
      },
      data: {
        code: food.code,
        quantity: countToEat,
        hpRestore: food.hpRestore,
      },
    });
    try {
      const result = await api.useItem(food.code, countToEat, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
    } catch (err) {
      if (err.code === 476) {
        foodLog.debug(`[${ctx.name}] ${food.code} is not consumable, skipping`, {
          event: 'food.consume.skipped',
          reasonCode: 'insufficient_skill',
          context: {
            character: ctx.name,
          },
          data: {
            code: food.code,
          },
        });
        continue;
      }
      if (isConditionNotMet(err)) {
        foodLog.debug(`[${ctx.name}] Cannot use ${food.code} right now (${err.message}), skipping`, {
          event: 'food.consume.skipped',
          reasonCode: 'routine_conditions_changed',
          context: {
            character: ctx.name,
          },
          error: err,
          data: {
            code: food.code,
          },
        });
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
    foodLog.info(`[${ctx.name}] Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`, {
      event: 'food.rest.start',
      context: {
        character: ctx.name,
      },
      data: {
        hp: c.hp,
        maxHp: c.max_hp,
        targetPct: hpPct,
      },
    });
    try {
      const result = await api.rest(ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
      restRetries = 0;
    } catch (err) {
      if (isConditionNotMet(err)) {
        restRetries++;
        if (restRetries >= MAX_REST_RETRIES) {
          foodLog.warn(`[${ctx.name}] Rest failed ${MAX_REST_RETRIES} times (${err.message}); giving up`, {
            event: 'food.rest.failed',
            reasonCode: 'request_failed',
            context: {
              character: ctx.name,
            },
            error: err,
          });
          return false;
        }
        foodLog.debug(`[${ctx.name}] Rest unavailable (${err.message}), retry ${restRetries}/${MAX_REST_RETRIES}`, {
          event: 'food.rest.retry',
          reasonCode: 'routine_conditions_changed',
          context: {
            character: ctx.name,
          },
          error: err,
          data: {
            retry: restRetries,
            maxRetries: MAX_REST_RETRIES,
          },
        });
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  return true;
}

/**
 * Check whether a character is ready to fight a monster safely.
 * Returns a structured result so callers can distinguish true unwinnable fights
 * from temporary rest failures.
 *
 * @returns {Promise<{
 *   status: 'ready' | 'needs_rest' | 'unwinnable',
 *   requiredHp: number | null,
 *   maxHp: number,
 *   targetPct: number | null,
 *   winRate: number,
 *   threshold: number,
 *   iterations: number,
 * }>}
 */
export async function getFightReadiness(ctx, monsterCode) {
  const c = ctx.get();
  const monster = gameData.getMonster(monsterCode);
  const maxHp = c.max_hp;
  if (!monster) {
    return {
      status: 'unwinnable',
      requiredHp: null,
      maxHp,
      targetPct: null,
      winRate: 0,
      threshold: 0,
      iterations: 0,
    };
  }

  const simOptions = buildEquippedSimOptions(c);
  const fullHpResult = simulateCombat(c, monster, simOptions);
  const minHp = hpNeededForFight(ctx, monsterCode, simOptions);
  if (minHp === null) {
    return {
      status: 'unwinnable',
      requiredHp: null,
      maxHp,
      targetPct: null,
      winRate: fullHpResult.winRate,
      threshold: fullHpResult.threshold,
      iterations: fullHpResult.iterations,
    };
  }

  const targetPct = Math.ceil((minHp / maxHp) * 100);
  const currentResult = c.hp >= minHp
    ? simulateCombat(c, monster, { ...simOptions, startingHp: c.hp })
    : fullHpResult;
  if (c.hp >= minHp) {
    return {
      status: 'ready',
      requiredHp: minHp,
      maxHp,
      targetPct,
      winRate: currentResult.winRate,
      threshold: currentResult.threshold,
      iterations: currentResult.iterations,
    };
  }

  if (targetPct > 100) {
    foodLog.warn(`[${ctx.name}] Cannot fight ${monsterCode} — need ${minHp}hp but max is ${maxHp}hp (${targetPct}%)`, {
      event: 'food.rest_before_fight.unwinnable',
      reasonCode: 'unwinnable_combat',
      context: {
        character: ctx.name,
      },
      data: {
        monsterCode,
        requiredHp: minHp,
        maxHp,
      },
    });
    return {
      status: 'unwinnable',
      requiredHp: minHp,
      maxHp,
      targetPct,
      winRate: fullHpResult.winRate,
      threshold: fullHpResult.threshold,
      iterations: fullHpResult.iterations,
    };
  }

  foodLog.info(`[${ctx.name}] Need ${minHp}hp (${targetPct}%) to fight ${monsterCode}, have ${c.hp}hp`, {
    event: 'food.rest_before_fight.required',
    context: {
      character: ctx.name,
    },
    data: {
      monsterCode,
      currentHp: c.hp,
      requiredHp: minHp,
      targetPct,
    },
  });
  const recovered = await restUntil(ctx, targetPct);
  if (!recovered) {
    const fresh = ctx.get();
    if (fresh.hp < minHp) {
      foodLog.warn(`[${ctx.name}] Cannot reach ${minHp}hp for ${monsterCode} (have ${fresh.hp}hp)`, {
        event: 'food.rest_before_fight.failed',
        reasonCode: 'yield_for_rest',
        context: {
          character: ctx.name,
        },
        data: {
          monsterCode,
          currentHp: fresh.hp,
          requiredHp: minHp,
        },
      });
      return {
        status: 'needs_rest',
        requiredHp: minHp,
        maxHp: fresh.max_hp,
        targetPct,
        winRate: fullHpResult.winRate,
        threshold: fullHpResult.threshold,
        iterations: fullHpResult.iterations,
      };
    }
  }

  const fresh = ctx.get();
  const freshResult = simulateCombat(fresh, monster, { ...simOptions, startingHp: fresh.hp });
  return {
    status: fresh.hp >= minHp ? 'ready' : 'needs_rest',
    requiredHp: minHp,
    maxHp: fresh.max_hp,
    targetPct,
    winRate: freshResult.winRate,
    threshold: freshResult.threshold,
    iterations: freshResult.iterations,
  };
}

/**
 * Backward-compatible boolean wrapper for older callers.
 * New code should use getFightReadiness() directly.
 */
export async function restBeforeFight(ctx, monsterCode) {
  const readiness = await getFightReadiness(ctx, monsterCode);
  return readiness.status === 'ready';
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
  const result = simulateCombat(charStats, monster, buildEquippedSimOptions(charStats));
  if (!result.canWin || result.avgHpLostOnWin == null) return false;

  const damageTaken = Math.round(result.avgHpLostOnWin);
  const totalHealingNeeded = Math.max(0, damageTaken * numFights - (charStats.max_hp - 1));

  if (totalHealingNeeded <= 0) {
    foodLog.debug(`[${ctx.name}] Food: no healing needed for ${numFights} fights vs ${monsterCode}`, {
      event: 'food.withdraw.skipped',
      reasonCode: 'yield_for_backoff',
      context: {
        character: ctx.name,
      },
      data: {
        monsterCode,
        numFights,
      },
    });
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
    foodLog.debug(`[${ctx.name}] Food: inventory already covers ${numFights} fights vs ${monsterCode}`, {
      event: 'food.withdraw.skipped',
      reasonCode: 'yield_for_backoff',
      context: {
        character: ctx.name,
      },
      data: {
        monsterCode,
        numFights,
      },
    });
    return true;
  }

  // Find food in bank
  const bank = await gameData.getBankItems(true);
  const bankFoods = findBankFood(bank, ctx.get());
  if (bankFoods.length === 0) {
    foodLog.info(`[${ctx.name}] Food: no usable food in bank, will rely on rest API`, {
      event: 'food.withdraw.skipped',
      reasonCode: 'bank_unavailable',
      context: {
        character: ctx.name,
      },
      data: {
        monsterCode,
      },
    });
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

  // Cap by available inventory space, reserving slots for fight drops
  const DROP_RESERVE = 8;
  let totalCount = toWithdraw.reduce((sum, w) => sum + w.quantity, 0);
  const rawSpace = ctx.inventoryCapacity() - ctx.inventoryCount();
  const space = Math.max(0, rawSpace - DROP_RESERVE);
  if (totalCount > space && space > 0) {
    const scale = space / totalCount;
    for (const w of toWithdraw) {
      w.quantity = Math.max(1, Math.floor(w.quantity * scale));
    }
  } else if (space <= 0) {
    foodLog.info(`[${ctx.name}] Food: no inventory space for food`, {
      event: 'food.withdraw.skipped',
      reasonCode: 'inventory_full',
      context: {
        character: ctx.name,
      },
      data: {
        monsterCode,
      },
    });
    return true;
  }

  // Withdraw from bank (bank-ops handles travel to the nearest accessible bank)
  for (const w of toWithdraw) {
    if (w.quantity <= 0) continue;
    foodLog.info(`[${ctx.name}] Food: withdrawing ${w.code} x${w.quantity} for ${numFights} fights vs ${monsterCode}`, {
      event: 'food.withdraw.start',
      context: {
        character: ctx.name,
      },
      data: {
        code: w.code,
        quantity: w.quantity,
        monsterCode,
        numFights,
      },
    });
  }
  const withdrawalResult = await withdrawBankItems(ctx, toWithdraw, {
    reason: `food withdrawal for ${monsterCode}`,
    mode: 'partial',
    retryStaleOnce: true,
  });
  logWithdrawalWarnings(ctx, withdrawalResult, 'Food');

  return true;
}
