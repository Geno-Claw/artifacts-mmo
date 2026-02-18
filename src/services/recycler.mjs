/**
 * Equipment recycling service.
 * Identifies surplus equipment and recycles it at workshops,
 * breaking it down into crafting materials.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { applyBankDelta, availableBankCount, bankCount, globalCount, invalidateBank } from './inventory-manager.mjs';
import { getSellRules } from './ge-seller.mjs';
import { moveTo } from '../helpers.mjs';
import { BANK } from '../data/locations.mjs';

// --- Concurrency control (same pattern as ge-seller.mjs) ---

let _recycleLock = null;

async function withRecycleLock(fn) {
  while (_recycleLock) await _recycleLock;
  let release;
  _recycleLock = new Promise(r => { release = r; });
  try {
    return await fn();
  } finally {
    _recycleLock = null;
    release();
  }
}

// --- Analysis ---

/**
 * Determine which equipment to recycle from bank contents.
 * Only considers equipment with a craft skill (recyclable at a workshop).
 * Respects neverSell, keepPerEquipmentCode, and ring x2 multiplier.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems - code -> quantity
 * @returns {Array<{ code: string, quantity: number, reason: string, craftSkill: string }>}
 */
export function analyzeRecycleCandidates(ctx, bankItems) {
  const sellRules = getSellRules();
  if (!sellRules?.sellDuplicateEquipment) return [];

  const candidates = [];
  const neverSellSet = new Set(sellRules.neverSell || []);
  const baseKeep = sellRules.keepPerEquipmentCode ?? 1;

  for (const [code, bankQty] of bankItems.entries()) {
    if (neverSellSet.has(code)) continue;

    const item = gameData.getItem(code);
    if (!item || !gameData.isEquipmentType(item)) continue;

    // Must have craft property to be recyclable
    if (!item.craft?.skill) continue;

    const keep = item.type === 'ring' ? baseKeep * 2 : baseKeep;
    const totalOwned = globalCount(code);
    const surplus = totalOwned - keep;
    const qty = Math.min(Math.max(surplus, 0), bankCount(code));
    if (qty <= 0) continue;

    candidates.push({
      code,
      quantity: qty,
      reason: `duplicate equipment (owned: ${totalOwned}, bank: ${bankQty}, keeping ${keep}${item.type === 'ring' ? ' (ring x2)' : ''})`,
      craftSkill: item.craft.skill,
    });
  }

  return candidates;
}

// --- Main recycle flow ---

/**
 * Execute the full recycle flow for a character.
 * Assumes character has already deposited inventory to bank.
 * Uses an async mutex so only one character recycles at a time,
 * preventing concurrent reads of stale bank state.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @returns {Promise<number>} Number of item types successfully recycled
 */
export async function executeRecycleFlow(ctx) {
  if (_recycleLock) {
    log.info(`[${ctx.name}] Recycle: waiting for another character's recycle flow to finish`);
  }

  return withRecycleLock(async () => {
    const workshops = await gameData.getWorkshops();

    // Force-refresh bank inside the lock to get current state
    const bankItems = await gameData.getBankItems(true);

    const candidates = analyzeRecycleCandidates(ctx, bankItems);
    if (candidates.length === 0) {
      log.info(`[${ctx.name}] Recycle: no equipment to recycle`);
      return 0;
    }

    log.info(`[${ctx.name}] Recycle: ${candidates.length} item(s) to recycle: ${candidates.map(c => `${c.code} x${c.quantity}`).join(', ')}`);

    // Group by craft skill for efficient workshop travel
    const groups = new Map();
    for (const candidate of candidates) {
      const skill = candidate.craftSkill;
      if (!workshops[skill]) {
        log.warn(`[${ctx.name}] Recycle: no workshop found for ${skill}, skipping ${candidate.code}`);
        continue;
      }
      if (!groups.has(skill)) groups.set(skill, []);
      groups.get(skill).push(candidate);
    }

    let totalRecycled = 0;

    for (const [skill, items] of groups) {
      const workshop = workshops[skill];
      totalRecycled += await _recycleGroup(ctx, skill, workshop, items);
    }

    log.info(`[${ctx.name}] Recycle: completed, ${totalRecycled} item type(s) recycled`);
    return totalRecycled;
  });
}

// --- Private helpers ---

async function _recycleGroup(ctx, skill, workshop, items) {
  let recycled = 0;

  // Step 1: Withdraw items from bank
  await moveTo(ctx, BANK.x, BANK.y);
  const withdrawn = [];

  for (const candidate of items) {
    const space = ctx.inventoryCapacity() - ctx.inventoryCount();
    if (space <= 0) {
      log.warn(`[${ctx.name}] Recycle: inventory full, stopping withdrawals for ${skill}`);
      break;
    }

    const available = availableBankCount(candidate.code, { includeChar: ctx.name });
    const qty = Math.min(candidate.quantity, space, available);
    if (qty <= 0) continue;

    try {
      const result = await api.withdrawBank([{ code: candidate.code, quantity: qty }], ctx.name);
      await api.waitForCooldown(result);
      applyBankDelta([{ code: candidate.code, quantity: qty }], 'withdraw', {
        charName: ctx.name,
        reason: `recycler withdrawal (${skill})`,
      });
      await ctx.refresh();
      withdrawn.push({ code: candidate.code, quantity: qty });
    } catch (err) {
      invalidateBank(`[${ctx.name}] recycler withdraw failed for ${candidate.code}: ${err.message}`);
      log.warn(`[${ctx.name}] Recycle: could not withdraw ${candidate.code}: ${err.message}`);
    }
  }

  if (withdrawn.length === 0) return 0;

  // Step 2: Move to workshop
  await moveTo(ctx, workshop.x, workshop.y);

  // Step 3: Recycle each item
  for (const item of withdrawn) {
    const actualQty = ctx.itemCount(item.code);
    if (actualQty <= 0) continue;

    const qty = Math.min(item.quantity, actualQty);

    try {
      log.info(`[${ctx.name}] Recycle: recycling ${item.code} x${qty} at ${skill} workshop`);
      const result = await api.recycle(item.code, qty, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      recycled++;
      log.info(`[${ctx.name}] Recycle: successfully recycled ${item.code} x${qty}`);
    } catch (err) {
      if (err.code === 473) {
        log.info(`[${ctx.name}] Recycle: ${item.code} cannot be recycled (error 473), will re-deposit`);
      } else {
        log.warn(`[${ctx.name}] Recycle: failed to recycle ${item.code}: ${err.message}`);
      }
    }

    // Check if inventory is getting full from recycled materials
    if (ctx.inventoryCount() >= ctx.inventoryCapacity() * 0.9) {
      log.info(`[${ctx.name}] Recycle: inventory nearly full, depositing materials`);
      await _depositInventory(ctx);
      await moveTo(ctx, workshop.x, workshop.y);
    }
  }

  // Step 4: Deposit everything (recycled materials + any failed-to-recycle items)
  await _depositInventory(ctx);

  return recycled;
}

async function _depositInventory(ctx) {
  const items = ctx.get().inventory
    .filter(slot => slot.code)
    .map(slot => ({ code: slot.code, quantity: slot.quantity }));
  if (items.length === 0) return;

  await moveTo(ctx, BANK.x, BANK.y);
  log.info(`[${ctx.name}] Recycle: depositing ${items.length} item(s) to bank`);
  try {
    const result = await api.depositBank(items, ctx.name);
    await api.waitForCooldown(result);
    applyBankDelta(items, 'deposit', { charName: ctx.name, reason: 'recycler deposit' });
    await ctx.refresh();
  } catch (err) {
    invalidateBank(`[${ctx.name}] recycler deposit failed: ${err.message}`);
    log.warn(`[${ctx.name}] Recycle: could not deposit items: ${err.message}`);
  }
}
