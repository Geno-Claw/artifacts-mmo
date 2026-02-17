/**
 * Reusable action patterns.
 * Every helper calls waitForCooldown + state.refresh() so callers don't have to.
 */
import * as api from './api.mjs';
import * as state from './state.mjs';
import * as log from './log.mjs';

/** Move to (x,y) if not already there. No-ops if already at target. */
export async function moveTo(x, y) {
  if (state.isAt(x, y)) return null;

  const c = state.get();
  log.info(`Moving (${c.x},${c.y}) → (${x},${y})`);
  const result = await api.move(x, y);
  await api.waitForCooldown(result);
  await state.refresh();
  return result;
}

/** Rest until HP reaches the given percentage. */
export async function restUntil(hpPct = 80) {
  while (state.hpPercent() < hpPct) {
    const c = state.get();
    log.info(`Resting (${c.hp}/${c.max_hp} HP, want ${hpPct}%)`);
    const result = await api.rest();
    await api.waitForCooldown(result);
    await state.refresh();
  }
}

/** Single fight. Returns the full action result. */
export async function fightOnce() {
  const result = await api.fight();
  await api.waitForCooldown(result);
  await state.refresh();
  return result;
}

/** Single gather. Returns the full action result. */
export async function gatherOnce() {
  const result = await api.gather();
  await api.waitForCooldown(result);
  await state.refresh();
  return result;
}

/** Move to bank and deposit all inventory items. */
export async function depositAll(bankX = 4, bankY = 1) {
  await moveTo(bankX, bankY);
  const inv = state.get().inventory;
  for (const slot of inv) {
    if (!slot.code) continue;
    log.info(`Depositing ${slot.code} x${slot.quantity}`);
    const result = await api.depositBank(slot.code, slot.quantity);
    await api.waitForCooldown(result);
  }
  await state.refresh();
}
