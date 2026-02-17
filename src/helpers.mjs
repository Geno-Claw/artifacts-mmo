/**
 * Reusable action patterns.
 * Every helper takes a CharacterContext as first arg and handles
 * waitForCooldown + ctx.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as log from './log.mjs';
import * as gameData from './services/game-data.mjs';
import { hpNeededForFight } from './services/combat-simulator.mjs';

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

/** Move to bank and withdraw a specific item. */
export async function withdrawItem(ctx, code, quantity = 1, bankX = 4, bankY = 1) {
  await moveTo(ctx, bankX, bankY);
  log.info(`[${ctx.name}] Withdrawing ${code} x${quantity}`);
  const result = await api.withdrawBank([{ code, quantity }], ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  return result;
}

/** Move to bank and deposit all inventory items. */
export async function depositAll(ctx, bankX = 4, bankY = 1) {
  await moveTo(ctx, bankX, bankY);
  const items = ctx.get().inventory
    .filter(slot => slot.code)
    .map(slot => ({ code: slot.code, quantity: slot.quantity }));
  if (items.length === 0) return;
  log.info(`[${ctx.name}] Depositing ${items.length} item(s): ${items.map(i => `${i.code} x${i.quantity}`).join(', ')}`);
  const result = await api.depositBank(items, ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
}
