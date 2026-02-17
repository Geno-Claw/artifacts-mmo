/**
 * Reusable action patterns.
 * Every helper takes a CharacterContext as first arg and handles
 * waitForCooldown + ctx.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as log from './log.mjs';

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

/** Rest until HP reaches the given percentage. */
export async function restUntil(ctx, hpPct = 80) {
  while (ctx.hpPercent() < hpPct) {
    const c = ctx.get();
    log.info(`[${ctx.name}] Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`);
    const result = await api.rest(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
  }
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

/** Move to bank and deposit all inventory items. */
export async function depositAll(ctx, bankX = 4, bankY = 1) {
  await moveTo(ctx, bankX, bankY);
  const inv = ctx.get().inventory;
  for (const slot of inv) {
    if (!slot.code) continue;
    log.info(`[${ctx.name}] Depositing ${slot.code} x${slot.quantity}`);
    const result = await api.depositBank(slot.code, slot.quantity, ctx.name);
    await api.waitForCooldown(result);
  }
  await ctx.refresh();
}
