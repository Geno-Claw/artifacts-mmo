/**
 * Combat potion manager.
 * Selects and maintains utility slots with potion-specific policies.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { toPositiveInt } from '../utils.mjs';
import * as gameData from './game-data.mjs';
import { canUseItem } from './item-conditions.mjs';
import { simulateCombat } from './combat-simulator.mjs';
import { withdrawBankItems } from './bank-ops.mjs';

let _api = api;
let _log = log;
let _gameData = gameData;
let _canUseItem = canUseItem;
let _simulateCombat = simulateCombat;
let _withdrawBankItems = withdrawBankItems;

const DEFAULT_COMBAT_SETTINGS = Object.freeze({
  enabled: true,
  refillBelow: 5,
  targetQuantity: 20,
  poisonBias: true,
  respectNonPotionUtility: true,
});

function getCombatSettings(ctx) {
  const cfg = ctx?.settings?.()?.potions?.combat || {};
  return { ...DEFAULT_COMBAT_SETTINGS, ...cfg };
}

function normalizeSlotCode(code) {
  if (typeof code !== 'string') return null;
  if (!code || code === 'none') return null;
  return code;
}

function isUtilityPotion(item) {
  return item?.type === 'utility' && item?.subtype === 'potion';
}

function hasMonsterPoison(monster) {
  return (monster?.effects || []).some(e => (e.code || e.name) === 'poison');
}

function effectValue(item, code) {
  let total = 0;
  for (const effect of item?.effects || []) {
    const effectCode = effect.code || effect.name;
    if (effectCode === code) total += toPositiveInt(effect.value);
  }
  return total;
}

function countEquippedPotion(c, code) {
  if (!code) return 0;
  let total = 0;
  if (normalizeSlotCode(c.utility1_slot) === code) total += toPositiveInt(c.utility1_slot_quantity);
  if (normalizeSlotCode(c.utility2_slot) === code) total += toPositiveInt(c.utility2_slot_quantity);
  return total;
}

function collectPotionCandidates(ctx, bankItems) {
  const c = ctx.get();
  const codeSet = new Set();

  const list = _gameData.findItems({ type: 'utility', subtype: 'potion', maxLevel: c.level }) || [];
  for (const item of list) codeSet.add(item.code);

  for (const slot of c.inventory || []) {
    if (!slot?.code || slot.quantity <= 0) continue;
    const item = _gameData.getItem(slot.code);
    if (isUtilityPotion(item)) codeSet.add(slot.code);
  }

  for (const code of [normalizeSlotCode(c.utility1_slot), normalizeSlotCode(c.utility2_slot)]) {
    if (!code) continue;
    const item = _gameData.getItem(code);
    if (isUtilityPotion(item)) codeSet.add(code);
  }

  const out = [];
  for (const code of codeSet) {
    const item = _gameData.getItem(code);
    if (!isUtilityPotion(item)) continue;
    if (!_canUseItem(item, c)) continue;

    const inInventory = ctx.itemCount(code);
    const inBank = bankItems.get(code) || 0;
    const equipped = countEquippedPotion(c, code);
    const available = inInventory + inBank + equipped;
    if (available <= 0) continue;

    out.push({
      code,
      item,
      available,
      inInventory,
      inBank,
      equipped,
    });
  }

  return out.sort((a, b) => a.code.localeCompare(b.code));
}

function compareByEffectThenLevel(a, b, effectCode) {
  const aVal = effectValue(a.item, effectCode);
  const bVal = effectValue(b.item, effectCode);
  if (aVal !== bVal) return bVal - aVal;
  if ((a.item.level || 0) !== (b.item.level || 0)) return (b.item.level || 0) - (a.item.level || 0);
  return a.code.localeCompare(b.code);
}

function applyPotionEffects(stats, item) {
  const next = { ...stats };
  for (const effect of item?.effects || []) {
    const code = effect.code || effect.name;
    const value = Number(effect.value) || 0;
    if (!code || !Number.isFinite(value) || value === 0) continue;

    if (code === 'boost_hp') {
      next.max_hp = (next.max_hp || 0) + value;
      next.hp = (next.hp || next.max_hp || 0) + value;
      continue;
    }
    if (code === 'boost_dmg') {
      next.dmg = (next.dmg || 0) + value;
      continue;
    }
    if (code.startsWith('boost_dmg_')) {
      const key = code.replace('boost_', '');
      next[key] = (next[key] || 0) + value;
      continue;
    }
    if (code.startsWith('boost_res_')) {
      const key = code.replace('boost_', '');
      next[key] = (next[key] || 0) + value;
    }
  }
  return next;
}

function scorePotionCandidate(item, charStats, monster, { poisonBias = true, healHeuristic = false } = {}) {
  const hypoStats = applyPotionEffects(charStats, item);
  // Pass the candidate utility to the simulator so restore/antipoison are modeled
  const simOpts = { utilities: [{ code: item.code, effects: item.effects }] };
  const sim = _simulateCombat(hypoStats, monster, simOpts);
  let score = 0;

  if (sim.win) score += 1_000_000;
  score += Math.round((100 - sim.hpLostPercent) * 1000);
  score += Math.round((100 - sim.turns) * 10);

  if (poisonBias && hasMonsterPoison(monster) && effectValue(item, 'antipoison') > 0) {
    score += 500;
  }
  if (healHeuristic) {
    score += effectValue(item, 'restore') * 2;
    score += effectValue(item, 'splash_restore');
  }

  return { score, sim };
}

function chooseBestBySim(candidates, charStats, monster, opts = {}) {
  let best = null;
  for (const candidate of candidates) {
    const { score, sim } = scorePotionCandidate(candidate.item, charStats, monster, opts);
    const row = { ...candidate, score, sim };
    if (!best) {
      best = row;
      continue;
    }
    if (row.score !== best.score) {
      if (row.score > best.score) best = row;
      continue;
    }
    if ((row.item.level || 0) !== (best.item.level || 0)) {
      if ((row.item.level || 0) > (best.item.level || 0)) best = row;
      continue;
    }
    if (row.code.localeCompare(best.code) < 0) best = row;
  }
  return best;
}

function chooseUtility1(candidates, charStats, monster, settings) {
  const restore = candidates
    .filter(c => effectValue(c.item, 'restore') > 0)
    .sort((a, b) => compareByEffectThenLevel(a, b, 'restore'))[0];
  if (restore) return { ...restore, reason: 'restore' };

  const splash = candidates
    .filter(c => effectValue(c.item, 'splash_restore') > 0)
    .sort((a, b) => compareByEffectThenLevel(a, b, 'splash_restore'))[0];
  if (splash) return { ...splash, reason: 'splash_restore' };

  const sim = chooseBestBySim(candidates, charStats, monster, {
    poisonBias: settings.poisonBias,
    healHeuristic: true,
  });
  return sim ? { ...sim, reason: 'sim_fallback' } : null;
}

function chooseUtility2(candidates, utility1Code, charStats, monster, settings) {
  const pool = candidates.filter(c => c.code !== utility1Code);
  return chooseBestBySim(pool, charStats, monster, { poisonBias: settings.poisonBias });
}

async function ensureInventoryQty(ctx, code, quantity, reason) {
  const need = Math.max(0, toPositiveInt(quantity) - ctx.itemCount(code));
  if (need <= 0) return;

  const result = await _withdrawBankItems(ctx, [{ code, quantity: need }], {
    reason,
    mode: 'partial',
    retryStaleOnce: true,
  });
  for (const row of result.failed) {
    _log.warn(`[${ctx.name}] Potions: could not withdraw ${row.code}: ${row.error}`);
  }
  for (const row of result.skipped) {
    if (!row.reason.startsWith('partial fill')) {
      _log.warn(`[${ctx.name}] Potions: skipped ${row.code} (${row.reason})`);
    }
  }
}

function getSlotState(c, slot) {
  const code = normalizeSlotCode(c[`${slot}_slot`]);
  return {
    code,
    quantity: toPositiveInt(c[`${slot}_slot_quantity`]),
  };
}

async function unequipSlot(ctx, slot, quantity) {
  const qty = Math.max(1, toPositiveInt(quantity));
  const action = await _api.unequipItem(slot, ctx.name, qty);
  ctx.applyActionResult(action);
  await _api.waitForCooldown(action);
}

async function equipSlot(ctx, slot, code, quantity) {
  const qty = Math.max(1, toPositiveInt(quantity));
  const action = await _api.equipItem(slot, code, ctx.name, qty);
  ctx.applyActionResult(action);
  await _api.waitForCooldown(action);
}

async function ensureSlotPotion(ctx, slot, desiredCode, settings) {
  const c = ctx.get();
  const current = getSlotState(c, slot);
  const currentItem = current.code ? _gameData.getItem(current.code) : null;
  const currentIsPotion = isUtilityPotion(currentItem);
  const refillBelow = toPositiveInt(settings.refillBelow);
  const targetQty = Math.max(1, toPositiveInt(settings.targetQuantity));

  if (!desiredCode) {
    if (current.code && currentIsPotion && current.quantity > 0) {
      if (ctx.inventoryCount() + current.quantity > ctx.inventoryCapacity()) {
        _log.warn(`[${ctx.name}] Potions: cannot unequip ${current.code} from ${slot}, inventory full`);
        return;
      }
      _log.info(`[${ctx.name}] Potions: clearing ${slot} (${current.code} x${current.quantity})`);
      await unequipSlot(ctx, slot, current.quantity);
    }
    return;
  }

  if (current.code && current.code !== desiredCode && settings.respectNonPotionUtility && !currentIsPotion) {
    _log.info(`[${ctx.name}] Potions: leaving ${slot} as ${current.code} (non-potion utility preserved)`);
    return;
  }

  if (current.code === desiredCode && current.quantity >= refillBelow) return;

  const reason = `combat utility refill ${slot} -> ${desiredCode}`;
  if (current.code === desiredCode && current.quantity > 0) {
    const addQty = Math.max(0, targetQty - current.quantity);
    if (addQty <= 0) return;
    await ensureInventoryQty(ctx, desiredCode, addQty, reason);

    if (ctx.itemCount(desiredCode) <= 0) {
      _log.warn(`[${ctx.name}] Potions: no ${desiredCode} available to refill ${slot}`);
      return;
    }

    try {
      const qty = Math.min(addQty, ctx.itemCount(desiredCode));
      await equipSlot(ctx, slot, desiredCode, qty);
      _log.info(`[${ctx.name}] Potions: topped up ${slot} with ${desiredCode} (+${qty})`);
      return;
    } catch (err) {
      if (err.code !== 485 && err.code !== 491) throw err;
      _log.info(`[${ctx.name}] Potions: ${slot} does not support additive equip, replacing stack`);
    }
  }

  if (current.code && current.quantity > 0) {
    if (ctx.inventoryCount() + current.quantity > ctx.inventoryCapacity()) {
      _log.warn(`[${ctx.name}] Potions: cannot swap ${slot}, inventory full`);
      return;
    }
    await unequipSlot(ctx, slot, current.quantity);
  }

  await ensureInventoryQty(ctx, desiredCode, targetQty, reason);
  const equipQty = Math.min(targetQty, ctx.itemCount(desiredCode));
  if (equipQty <= 0) {
    _log.warn(`[${ctx.name}] Potions: no ${desiredCode} available for ${slot}`);
    return;
  }

  await equipSlot(ctx, slot, desiredCode, equipQty);
  _log.info(`[${ctx.name}] Potions: set ${slot} = ${desiredCode} x${equipQty}`);
}

/**
 * Select + equip combat utility potions.
 * Slot policy:
 * - utility1: restore > splash_restore > sim fallback
 * - utility2: best remaining sim candidate (never same code as utility1)
 */
export async function prepareCombatPotions(ctx, monsterCode) {
  const globalEnabled = ctx?.settings?.()?.potions?.enabled !== false;
  const settings = getCombatSettings(ctx);
  if (!globalEnabled || !settings.enabled) return { selected: null };

  const monster = _gameData.getMonster(monsterCode);
  if (!monster) return { selected: null };

  const bankItems = await _gameData.getBankItems();
  const candidates = collectPotionCandidates(ctx, bankItems);
  if (candidates.length === 0) return { selected: null };

  const charStats = ctx.get();
  const utility1 = chooseUtility1(candidates, charStats, monster, settings);
  const utility2 = chooseUtility2(candidates, utility1?.code || null, charStats, monster, settings);

  if (utility1?.code) {
    _log.info(`[${ctx.name}] Potions: utility1 candidate ${utility1.code} (${utility1.reason})`);
  }
  if (utility2?.code) {
    _log.info(`[${ctx.name}] Potions: utility2 candidate ${utility2.code}`);
  }

  try {
    await ensureSlotPotion(ctx, 'utility1', utility1?.code || null, settings);
  } catch (err) {
    _log.warn(`[${ctx.name}] Potions: utility1 prep failed: ${err.message}`);
  }
  try {
    await ensureSlotPotion(ctx, 'utility2', utility2?.code || null, settings);
  } catch (err) {
    _log.warn(`[${ctx.name}] Potions: utility2 prep failed: ${err.message}`);
  }

  return {
    selected: {
      utility1: utility1?.code || null,
      utility2: utility2?.code || null,
    },
  };
}

// Test helpers.
export function _scorePotionCandidateForTests(item, charStats, monster, opts = {}) {
  return scorePotionCandidate(item, charStats, monster, opts);
}

export function _rankUtility1ForTests(candidates, charStats, monster, settings = {}) {
  const merged = { ...DEFAULT_COMBAT_SETTINGS, ...settings };
  return chooseUtility1(candidates, charStats, monster, merged);
}

export function _rankUtility2ForTests(candidates, utility1Code, charStats, monster, settings = {}) {
  const merged = { ...DEFAULT_COMBAT_SETTINGS, ...settings };
  return chooseUtility2(candidates, utility1Code, charStats, monster, merged);
}

export function _applyPotionEffectsForTests(stats, item) {
  return applyPotionEffects(stats, item);
}

export function _setDepsForTests(deps = {}) {
  _api = deps.api || _api;
  _log = deps.log || _log;
  _gameData = deps.gameData || _gameData;
  _canUseItem = deps.canUseItem || _canUseItem;
  _simulateCombat = deps.simulateCombat || _simulateCombat;
  _withdrawBankItems = deps.withdrawBankItems || _withdrawBankItems;
}

export function _resetForTests() {
  _api = api;
  _log = log;
  _gameData = gameData;
  _canUseItem = canUseItem;
  _simulateCombat = simulateCombat;
  _withdrawBankItems = withdrawBankItems;
}
