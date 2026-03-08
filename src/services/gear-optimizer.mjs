/**
 * Simulation-based combat gear optimizer.
 *
 * Evaluates equipment combinations using the combat simulator to find
 * the optimal loadout for a specific monster. Replaces the old static-weight
 * scoring system with fight-outcome-driven gear selection.
 *
 * Four-phase greedy approach:
 *   1. Weapon — maximize outgoing DPS (calcTurnDamage)
 *   2. Defensive slots — maximize survivability (simulateCombat → win rate)
 *   3. Accessories + rune — maximize survivability (simulateCombat → win rate)
 *   4. Bag — maximize inventory space
 */
import {
  calcTurnDamage,
  findRequiredHpForFight,
  isCombatResultViable,
  isBetterCombatResult,
  isCombatResultTie,
  isBetterTankResult,
  isTankResultTie,
  isBetterDpsResult,
  isDpsResultTie,
  simulateCombat,
} from './combat-simulator.mjs';
import { canUseItem } from './item-conditions.mjs';
import * as gameData from './game-data.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';
import { bankCount } from './inventory-manager.mjs';
import { TOOL_EFFECT_BY_SKILL } from './tool-policy.mjs';
import * as log from '../log.mjs';
import { toPositiveInt } from '../utils.mjs';

const DEFENSIVE_SLOTS = ['shield', 'helmet', 'body_armor', 'leg_armor', 'boots'];
const ARTIFACT_SLOTS = ['artifact1', 'artifact2', 'artifact3'];
const ACCESSORY_SLOTS = ['amulet', 'ring1', 'ring2', ...ARTIFACT_SLOTS, 'rune'];
const OPTIMIZER_CANDIDATE_ITERATIONS = 200;
const OPTIMIZER_FINAL_ITERATIONS = 400;
const MULTI_SLOT_FAMILIES = [
  ['ring1', 'ring2'],
  ARTIFACT_SLOTS,
];
const STRICT_DEFENSIVE_DOMINANCE_TYPES = new Set([
  'shield',
  'helmet',
  'body_armor',
  'leg_armor',
  'boots',
]);
const STRICT_DEFENSIVE_EFFECTS = new Set([
  'hp',
  'res_fire',
  'res_earth',
  'res_water',
  'res_air',
]);
const MULTI_SLOT_FAMILY_BY_SLOT = new Map(
  MULTI_SLOT_FAMILIES.flatMap(family => family.map(slot => [slot, family])),
);

/**
 * Extract combat sim options that stay fixed during gear optimization.
 * Utilities are constant here; runes come from the tested loadout.
 */
function getBaseSimOptions(ctx) {
  const c = ctx.get();
  const opts = {};
  const utilities = [];
  for (const slot of ['utility1', 'utility2']) {
    const code = c[`${slot}_slot`];
    if (!code) continue;
    const item = _deps.getItemFn(code);
    if (item?.effects) utilities.push({ code, effects: item.effects });
  }
  if (utilities.length > 0) opts.utilities = utilities;
  return opts;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSimOptions(baseOptions, gearSet, extraOptions = {}) {
  const opts = {};
  if (Array.isArray(baseOptions?.utilities) && baseOptions.utilities.length > 0) {
    opts.utilities = [...baseOptions.utilities];
  }

  const rune = gearSet?.get('rune') || null;
  if (rune?.effects?.length) {
    opts.rune = { code: rune.code, effects: rune.effects };
  }

  return { ...opts, ...extraOptions };
}

function buildOptimizerSeedBase(ctx, monsterCode) {
  const c = ctx.get();
  return hashString(JSON.stringify({
    character: ctx.name,
    monsterCode,
    level: Number(c?.level || 0),
    hp: Number(c?.hp || 0),
    maxHp: Number(c?.max_hp || 0),
    utility1: c?.utility1_slot || null,
    utility1Qty: Number(c?.utility1_slot_quantity || 0),
    utility2: c?.utility2_slot || null,
    utility2Qty: Number(c?.utility2_slot_quantity || 0),
  }));
}

let _deps = {
  calcTurnDamageFn: calcTurnDamage,
  findRequiredHpForFightFn: findRequiredHpForFight,
  simulateCombatFn: simulateCombat,
  getMonsterFn: (code) => gameData.getMonster(code),
  getMonsterLocationFn: (code) => gameData.getMonsterLocation(code),
  findMonstersByLevelFn: (maxLevel) => gameData.findMonstersByLevel(maxLevel),
  getBankItemsFn: (forceRefresh = false) => gameData.getBankItems(forceRefresh),
  getItemFn: (code) => gameData.getItem(code),
  getEquipmentForSlotFn: (slot, charLevel) => gameData.getEquipmentForSlot(slot, charLevel),
  findItemsFn: (filters) => gameData.findItems(filters),
  findNpcForItemFn: (code) => gameData.findNpcForItem(code),
  bankCountFn: (code) => bankCount(code),
};

// --- Base stats computation ---

/**
 * Strip all equipment effects from character stats to get "naked" base stats.
 * The API returns stats with equipment bonuses baked in, so we reverse that.
 */
function getBaseStats(ctx) {
  const c = ctx.get();
  const stats = { ...c };

  for (const slot of EQUIPMENT_SLOTS) {
    const itemCode = c[`${slot}_slot`] || null;
    if (!itemCode) continue;

    const item = _deps.getItemFn(itemCode);
    if (!item?.effects) continue;

    for (const effect of item.effects) {
      const key = effect.name || effect.code;
      if (key === 'hp') {
        stats.max_hp = (stats.max_hp || 0) - (effect.value || 0);
      } else {
        stats[key] = (stats[key] || 0) - (effect.value || 0);
      }
    }
  }

  return stats;
}

/**
 * Apply a gear set's effects on top of base stats.
 * @param {object} baseStats — naked stats (from getBaseStats)
 * @param {Map<string, object|null>} gearSet — Map<slot, item object or null>
 * @returns {object} hypothetical stats with gear applied
 */
function buildStats(baseStats, gearSet) {
  const stats = { ...baseStats };

  for (const [, item] of gearSet) {
    if (!item?.effects) continue;
    for (const effect of item.effects) {
      const key = effect.name || effect.code;
      if (key === 'hp') {
        stats.max_hp = (stats.max_hp || 0) + (effect.value || 0);
      } else {
        stats[key] = (stats[key] || 0) + (effect.value || 0);
      }
    }
  }

  return stats;
}

function getEffectValue(item, effectCode) {
  if (!item?.effects) return 0;
  for (const effect of item.effects) {
    if ((effect.name || effect.code) !== effectCode) continue;
    return Number(effect.value) || 0;
  }
  return 0;
}

function getInventorySpace(item) {
  return getEffectValue(item, 'inventory_space');
}

function isBetterBagItem(candidate, currentBest) {
  if (!candidate?.item) return false;
  if (!currentBest?.item) return true;

  const a = candidate.item;
  const b = currentBest.item;

  const invA = getInventorySpace(a);
  const invB = getInventorySpace(b);
  if (invA !== invB) return invA > invB;

  const levelA = Number(a.level) || 0;
  const levelB = Number(b.level) || 0;
  if (levelA !== levelB) return levelA > levelB;

  const codeA = `${a.code || ''}`;
  const codeB = `${b.code || ''}`;
  return codeA.localeCompare(codeB) < 0;
}

function chooseBestBagCandidate(candidates = []) {
  let best = null;
  for (const candidate of candidates) {
    if (isBetterBagItem(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

function loadoutCode(loadout, slot) {
  const value = loadout?.get(slot) ?? null;
  if (!value) return null;
  return typeof value === 'string' ? value : (value.code || null);
}

function effectCode(effect) {
  return `${effect?.name || effect?.code || ''}`.trim();
}

function getStrictDefensiveEffectMap(item) {
  if (!item?.code) return null;
  if (!STRICT_DEFENSIVE_DOMINANCE_TYPES.has(item.type)) return null;
  if (item.subtype === 'tool') return null;

  const effects = new Map();
  for (const effect of item.effects || []) {
    const code = effectCode(effect);
    if (!code || !STRICT_DEFENSIVE_EFFECTS.has(code)) return null;

    const value = Number(effect?.value);
    if (!Number.isFinite(value) || value < 0) return null;
    effects.set(code, (effects.get(code) || 0) + value);
  }

  return effects;
}

function strictlyDominatesDefensiveItem(dominator, candidate) {
  if (!dominator?.code || !candidate?.code) return false;
  if (dominator.code === candidate.code) return false;
  if (dominator.type !== candidate.type) return false;

  const dominatorEffects = getStrictDefensiveEffectMap(dominator);
  const candidateEffects = getStrictDefensiveEffectMap(candidate);
  if (!dominatorEffects || !candidateEffects) return false;

  let strictlyBetter = false;
  const keys = new Set([
    ...dominatorEffects.keys(),
    ...candidateEffects.keys(),
  ]);

  for (const key of keys) {
    const dominatorValue = dominatorEffects.get(key) || 0;
    const candidateValue = candidateEffects.get(key) || 0;
    if (dominatorValue < candidateValue) return false;
    if (dominatorValue > candidateValue) strictlyBetter = true;
  }

  return strictlyBetter;
}

function pruneDominatedDefensiveCandidates(candidates = []) {
  return candidates.filter((candidate, index) => {
    const item = candidate?.item || null;
    if (!item?.code) return true;

    for (let otherIndex = 0; otherIndex < candidates.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const otherItem = candidates[otherIndex]?.item || null;
      if (strictlyDominatesDefensiveItem(otherItem, item)) return false;
    }

    return true;
  });
}

// --- Candidate collection ---

/**
 * Collect all available items for a slot from equipped, inventory, and bank.
 * Filtered by character level. Returns deduplicated by item code.
 */
export function getCandidatesForSlot(ctx, slot, bankItems, opts = {}) {
  const includeCraftableUnavailable = opts.includeCraftableUnavailable === true;
  const includeVendorUnavailable = includeCraftableUnavailable && slot === 'rune';
  const char = ctx.get();
  const charLevel = char.level;
  const candidates = new Map(); // code → { item, source }

  // Currently equipped
  const equippedCode = char[`${slot}_slot`] || null;
  if (equippedCode) {
    const item = _deps.getItemFn(equippedCode);
    if (item) candidates.set(item.code, { item, source: 'equipped' });
  }

  // All items that fit this slot up to character level
  const allForSlot = _deps.getEquipmentForSlotFn(slot, charLevel);

  for (const item of allForSlot) {
    if (candidates.has(item.code)) continue;

    // Skip items the character doesn't meet conditions for (e.g. skill level requirements)
    if (!canUseItem(item, char)) continue;

    // Check inventory
    if (ctx.hasItem(item.code)) {
      candidates.set(item.code, { item, source: 'inventory' });
      continue;
    }

    // Check bank
    const excluded = opts.excludeBank?.get(item.code) || 0;
    const inBank = Math.max(0,
      Math.max(_deps.bankCountFn(item.code), bankItems?.get(item.code) || 0) - excluded,
    );
    if (inBank >= 1) {
      candidates.set(item.code, { item, source: 'bank' });
      continue;
    }

    // Planning mode: include craftable items that are not yet owned.
    if (includeCraftableUnavailable && item?.craft?.skill) {
      candidates.set(item.code, { item, source: 'craftable' });
      continue;
    }

    // Planning mode: runes can also be bought directly from NPC vendors.
    if (includeVendorUnavailable && _deps.findNpcForItemFn(item.code)) {
      candidates.set(item.code, { item, source: 'npc_buy' });
    }
  }

  return [...candidates.values()];
}

// --- Comparison ---

/**
 * Compare Monte Carlo combat results.
 * Priority:
 *  - viable beats non-viable
 *  - higher winRate
 *  - lower requiredHp (when attached)
 *  - fewer turns
 *  - higher remaining HP
 */
function isPreferredItemOnTie(candidate, currentBest) {
  if (!candidate && !currentBest) return false;
  if (candidate && !currentBest) return true;
  if (!candidate && currentBest) return false;

  const aLevel = Number(candidate.level) || 0;
  const bLevel = Number(currentBest.level) || 0;
  if (aLevel !== bLevel) return aLevel > bLevel;

  const aCode = `${candidate.code || ''}`;
  const bCode = `${currentBest.code || ''}`;
  return aCode.localeCompare(bCode) < 0;
}

/**
 * DPS-role tiebreaker: prefer offensive rune effects (burn, frenzy) over
 * defensive ones (lifesteal, healing) when the solo sim can't differentiate
 * (e.g. both die against a boss). Falls back to default tiebreaker.
 */
const DPS_RUNE_EFFECT_RANK = { burn: 0, frenzy: 1, lifesteal: 2, healing: 3 };

function isPreferredDpsItemOnTie(candidate, currentBest) {
  if (!candidate && !currentBest) return false;
  if (candidate && !currentBest) return true;
  if (!candidate && currentBest) return false;

  // Rune-specific: prefer offensive effects for DPS
  const aType = candidate.type || '';
  const bType = currentBest.type || '';
  if (aType === 'rune' && bType === 'rune') {
    const aRank = getDpsRuneRank(candidate);
    const bRank = getDpsRuneRank(currentBest);
    if (aRank !== bRank) return aRank < bRank;
  }

  return isPreferredItemOnTie(candidate, currentBest);
}

function getDpsRuneRank(item) {
  if (!item?.effects) return 99;
  for (const effect of item.effects) {
    const name = effect.name || effect.code || '';
    if (name in DPS_RUNE_EFFECT_RANK) return DPS_RUNE_EFFECT_RANK[name];
  }
  return 99;
}

function normalizeSimResult(result) {
  if (!result || typeof result !== 'object') return result;

  const canWin = typeof result.canWin === 'boolean'
    ? result.canWin
    : Boolean(result.win);
  const winRate = Number.isFinite(Number(result.winRate))
    ? Number(result.winRate)
    : (canWin ? 100 : 0);
  const avgTurns = Number.isFinite(Number(result.avgTurns))
    ? Number(result.avgTurns)
    : Number(result.turns || 0);
  const avgRemainingHp = Number.isFinite(Number(result.avgRemainingHp))
    ? Number(result.avgRemainingHp)
    : Number(result.remainingHp || 0);
  const avgHpLostPercent = Number.isFinite(Number(result.avgHpLostPercent))
    ? Number(result.avgHpLostPercent)
    : Number(result.hpLostPercent || 0);

  return {
    ...result,
    canWin,
    winRate,
    avgTurns,
    avgRemainingHp,
    avgHpLostPercent,
  };
}

// --- Duplicate-slot families ---

/**
 * Remove candidates that would exceed the number of owned copies within
 * duplicate-capable slot families (rings, artifacts).
 */
function filterDuplicateFamilyCandidates(candidates, slot, loadout, ctx, bankItems, opts = {}) {
  const familySlots = MULTI_SLOT_FAMILY_BY_SLOT.get(slot);
  if (!familySlots) return candidates;

  const slotIndex = familySlots.indexOf(slot);
  if (slotIndex <= 0) return candidates;

  const priorSlots = familySlots.slice(0, slotIndex);
  const includeCraftableUnavailable = opts.includeCraftableUnavailable === true;

  return candidates.filter(({ item, source }) => {
    const priorUses = priorSlots.reduce((count, priorSlot) => (
      loadoutCode(loadout, priorSlot) === item.code ? count + 1 : count
    ), 0);
    if (priorUses <= 0) return true;

    // Artifacts cannot stack the same item code across the family, even when
    // multiple copies are owned.
    if (familySlots === ARTIFACT_SLOTS) return false;

    if (includeCraftableUnavailable && source === 'craftable') return true;

    const c = ctx.get();
    const equippedCount = familySlots
      .map(familySlot => c[`${familySlot}_slot`] || null)
      .filter(code => code === item.code).length;
    const inInventory = ctx.itemCount(item.code);
    const inBank = Math.max(_deps.bankCountFn(item.code), bankItems?.get(item.code) || 0);
    return (equippedCount + inInventory + inBank) >= (priorUses + 1);
  });
}

function resetMultiSlotFamilyBaseline(loadout) {
  for (const family of MULTI_SLOT_FAMILIES) {
    for (const slot of family) {
      loadout.set(slot, null);
    }
  }
}

// --- Main optimizer ---

/**
 * Find the optimal gear loadout for fighting a specific monster.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @param {{ includeCraftableUnavailable?: boolean }} [opts]
 * @returns {Promise<{ loadout: Map<string, string|null>, simResult: object } | null>}
 */
export async function optimizeForMonster(ctx, monsterCode, opts = {}) {
  const candidateOpts = {
    includeCraftableUnavailable: opts.includeCraftableUnavailable === true,
    excludeBank: opts.excludeBank || null,
  };
  const candidateIterations = toPositiveInt(opts.candidateIterations, OPTIMIZER_CANDIDATE_ITERATIONS);
  const finalIterations = Math.max(candidateIterations, toPositiveInt(opts.finalIterations, OPTIMIZER_FINAL_ITERATIONS));
  const monster = _deps.getMonsterFn(monsterCode);
  if (!monster) return null;

  const bankItems = await _deps.getBankItemsFn();

  // Apply exclusions for team gear deconfliction
  if (opts.excludeBank) {
    for (const [code, qty] of opts.excludeBank) {
      const current = bankItems.get(code) || 0;
      if (current > 0) bankItems.set(code, Math.max(0, current - qty));
    }
  }

  const baseStats = getBaseStats(ctx);
  const baseSimOpts = getBaseSimOptions(ctx);
  const optimizerSeedBase = buildOptimizerSeedBase(ctx, monsterCode);
  const seedForSlot = (slot) => hashString(`${optimizerSeedBase}:${slot}`);

  // Start with current gear as baseline
  const loadout = new Map();
  for (const slot of EQUIPMENT_SLOTS) {
    const code = ctx.get()[`${slot}_slot`] || null;
    loadout.set(slot, code ? _deps.getItemFn(code) : null);
  }

  // --- Phase 1: Weapon (maximize combat viability) ---
  const weaponCandidates = getCandidatesForSlot(ctx, 'weapon', bankItems, candidateOpts);
  let bestWeaponResult = null;
  let bestWeapon = loadout.get('weapon');
  const weaponSeed = seedForSlot('weapon');

  for (const { item } of weaponCandidates) {
    const testLoadout = new Map(loadout);
    testLoadout.set('weapon', item);
    const hypo = buildStats(baseStats, testLoadout);
    const result = normalizeSimResult(_deps.simulateCombatFn(
      hypo,
      monster,
      buildSimOptions(baseSimOpts, testLoadout, {
        iterations: candidateIterations,
        seed: weaponSeed,
      }),
    ));
    if (
      isBetterCombatResult(result, bestWeaponResult)
      || (isCombatResultTie(result, bestWeaponResult) && isPreferredItemOnTie(item, bestWeapon))
    ) {
      bestWeaponResult = result;
      bestWeapon = item;
    }
  }
  loadout.set('weapon', bestWeapon);

  // --- Phase 2: Defensive slots (maximize survivability) ---
  for (const slot of DEFENSIVE_SLOTS) {
    const candidates = pruneDominatedDefensiveCandidates(
      getCandidatesForSlot(ctx, slot, bankItems, candidateOpts),
    );
    let bestResult = null;
    let bestItem = loadout.get(slot);
    const slotSeed = seedForSlot(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = normalizeSimResult(_deps.simulateCombatFn(
        hypo,
        monster,
        buildSimOptions(baseSimOpts, testLoadout, {
          iterations: candidateIterations,
          seed: slotSeed,
        }),
      ));
      if (
        isBetterCombatResult(result, bestResult)
        || (isCombatResultTie(result, bestResult) && isPreferredItemOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = normalizeSimResult(_deps.simulateCombatFn(
      emptyHypo,
      monster,
      buildSimOptions(baseSimOpts, emptyLoadout, {
        iterations: candidateIterations,
        seed: slotSeed,
      }),
    ));
    // Only strip gear if empty has a strictly higher win rate.
    // Secondary metrics (turns, remaining HP) should never cause an unequip —
    // the item may have non-combat benefits (XP, prospecting, etc.) and the
    // API action + cooldown cost of unequipping outweighs marginal sim differences.
    if (emptyResult?.winRate > (bestResult?.winRate ?? 0)) {
      bestItem = null;
    }

    loadout.set(slot, bestItem);
  }

  // Evaluate duplicate-capable accessory families from a clean baseline so we
  // do not temporarily count impossible extra copies from future slots.
  resetMultiSlotFamilyBaseline(loadout);

  // --- Phase 3: Accessories (maximize survivability, full sim) ---
  for (const slot of ACCESSORY_SLOTS) {
    const candidates = filterDuplicateFamilyCandidates(
      getCandidatesForSlot(ctx, slot, bankItems, candidateOpts),
      slot,
      loadout,
      ctx,
      bankItems,
      candidateOpts,
    );

    let bestResult = null;
    let bestItem = loadout.get(slot);
    const slotSeed = seedForSlot(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = normalizeSimResult(_deps.simulateCombatFn(
        hypo,
        monster,
        buildSimOptions(baseSimOpts, testLoadout, {
          iterations: candidateIterations,
          seed: slotSeed,
        }),
      ));
      if (
        isBetterCombatResult(result, bestResult)
        || (isCombatResultTie(result, bestResult) && isPreferredItemOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot — but only prefer empty if strictly better combat outcome.
    // Non-combat benefits (XP bonus, prospecting, etc.) aren't captured by the sim,
    // so we should never strip gear that ties with empty.
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = normalizeSimResult(_deps.simulateCombatFn(
      emptyHypo,
      monster,
      buildSimOptions(baseSimOpts, emptyLoadout, {
        iterations: candidateIterations,
        seed: slotSeed,
      }),
    ));
    // Only strip gear if empty has a strictly higher win rate.
    // Secondary metrics (turns, remaining HP) should never cause an unequip —
    // the item may have non-combat benefits (XP, prospecting, etc.) and the
    // API action + cooldown cost of unequipping outweighs marginal sim differences.
    if (emptyResult?.winRate > (bestResult?.winRate ?? 0)) {
      bestItem = null;
    }

    loadout.set(slot, bestItem);
  }

  // --- Phase 4: Bag (maximize inventory space) ---
  const bagCandidates = getCandidatesForSlot(ctx, 'bag', bankItems, candidateOpts);
  const bestBag = chooseBestBagCandidate(bagCandidates);
  if (bestBag?.item) {
    loadout.set('bag', bestBag.item);
  }

  // --- Final validation ---
  const finalStats = buildStats(baseStats, loadout);
  const finalSimOptions = buildSimOptions(baseSimOpts, loadout, {
    iterations: finalIterations,
    seed: seedForSlot('final'),
  });
  const finalResult = normalizeSimResult(_deps.simulateCombatFn(finalStats, monster, finalSimOptions));
  const requiredHp = _deps.findRequiredHpForFightFn(finalStats, monster, finalSimOptions);
  const simResult = {
    ...finalResult,
    requiredHp: requiredHp.requiredHp,
  };

  // Convert to slot → itemCode map
  const codeLoadout = new Map();
  for (const [slot, item] of loadout) {
    codeLoadout.set(slot, item?.code || null);
  }

  // Build change summary for logging
  const changes = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const current = ctx.get()[`${slot}_slot`] || null;
    const optimal = codeLoadout.get(slot) || null;
    if (current !== optimal) {
      changes.push(`${slot}: ${current || '(empty)'} → ${optimal || '(empty)'}`);
    }
  }

  if (changes.length > 0) {
    // Simulation-only — only log at info level when actually equipping (see helpers.mjs)
  }

  return { loadout: codeLoadout, simResult };
}

// --- Role-based optimizer ---

function itemHasThreat(item) {
  return getEffectValue(item, 'threat') > 0;
}

/**
 * Compute total threat from a gear set (Map<slot, item object>).
 */
function computeGearThreat(gearSet) {
  let total = 0;
  for (const [, item] of gearSet) {
    total += getEffectValue(item, 'threat');
  }
  return total;
}

/**
 * Optimize gear for a specific role in a boss fight.
 * Same 4-phase greedy structure as optimizeForMonster, but uses role-specific
 * comparison functions:
 *   - tank: maximize survivability (turns survived + remaining HP), threat is primary
 *   - dps: maximize damage output (lower monster remaining HP %), filter out threat items
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @param {'tank'|'dps'} role
 * @param {object} [opts]
 * @returns {Promise<{ loadout: Map<string, string|null>, simResult: object, gearThreat: number } | null>}
 */
export async function optimizeForRole(ctx, monsterCode, role, opts = {}) {
  const candidateOpts = {
    includeCraftableUnavailable: opts.includeCraftableUnavailable === true,
    excludeBank: opts.excludeBank || null,
  };
  const candidateIterations = toPositiveInt(opts.candidateIterations, OPTIMIZER_CANDIDATE_ITERATIONS);
  const finalIterations = Math.max(candidateIterations, toPositiveInt(opts.finalIterations, OPTIMIZER_FINAL_ITERATIONS));
  const monster = _deps.getMonsterFn(monsterCode);
  if (!monster) return null;

  const isTank = role === 'tank';

  const bankItems = await _deps.getBankItemsFn();

  if (opts.excludeBank) {
    for (const [code, qty] of opts.excludeBank) {
      const current = bankItems.get(code) || 0;
      if (current > 0) bankItems.set(code, Math.max(0, current - qty));
    }
  }

  const baseStats = getBaseStats(ctx);
  const baseSimOpts = getBaseSimOptions(ctx);
  const optimizerSeedBase = buildOptimizerSeedBase(ctx, monsterCode);
  const seedForSlot = (slot) => hashString(`${optimizerSeedBase}:${role}:${slot}`);

  // Role-specific comparison helpers
  const isBetter = isTank
    ? (result, bestResult, item, bestItem) => {
      const at = getEffectValue(item, 'threat');
      const bt = getEffectValue(bestItem, 'threat');
      return isBetterTankResult(result, bestResult, at, bt);
    }
    : (result, bestResult) => isBetterDpsResult(result, bestResult);

  const isTie = isTank
    ? (result, bestResult, item, bestItem) => {
      const at = getEffectValue(item, 'threat');
      const bt = getEffectValue(bestItem, 'threat');
      return isTankResultTie(result, bestResult, at, bt);
    }
    : (result, bestResult) => isDpsResultTie(result, bestResult);

  // DPS candidate filter: skip items with threat effect
  const filterCandidates = isTank
    ? (candidates) => candidates
    : (candidates) => candidates.filter(({ item }) => !itemHasThreat(item));

  // Role-aware tiebreaker: DPS prefers offensive rune effects
  const preferredOnTie = isTank ? isPreferredItemOnTie : isPreferredDpsItemOnTie;

  // Start with current gear as baseline
  const loadout = new Map();
  for (const slot of EQUIPMENT_SLOTS) {
    const code = ctx.get()[`${slot}_slot`] || null;
    loadout.set(slot, code ? _deps.getItemFn(code) : null);
  }

  // --- Phase 1: Weapon ---
  const weaponCandidates = filterCandidates(getCandidatesForSlot(ctx, 'weapon', bankItems, candidateOpts));
  let bestWeaponResult = null;
  let bestWeapon = loadout.get('weapon');
  const weaponSeed = seedForSlot('weapon');

  for (const { item } of weaponCandidates) {
    const testLoadout = new Map(loadout);
    testLoadout.set('weapon', item);
    const hypo = buildStats(baseStats, testLoadout);
    const result = normalizeSimResult(_deps.simulateCombatFn(
      hypo, monster,
      buildSimOptions(baseSimOpts, testLoadout, { iterations: candidateIterations, seed: weaponSeed }),
    ));
    if (
      isBetter(result, bestWeaponResult, item, bestWeapon)
      || (isTie(result, bestWeaponResult, item, bestWeapon) && preferredOnTie(item, bestWeapon))
    ) {
      bestWeaponResult = result;
      bestWeapon = item;
    }
  }
  loadout.set('weapon', bestWeapon);

  // --- Phase 2: Defensive slots ---
  for (const slot of DEFENSIVE_SLOTS) {
    const candidates = pruneDominatedDefensiveCandidates(
      filterCandidates(getCandidatesForSlot(ctx, slot, bankItems, candidateOpts)),
    );
    let bestResult = null;
    let bestItem = loadout.get(slot);
    const slotSeed = seedForSlot(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = normalizeSimResult(_deps.simulateCombatFn(
        hypo, monster,
        buildSimOptions(baseSimOpts, testLoadout, { iterations: candidateIterations, seed: slotSeed }),
      ));
      if (
        isBetter(result, bestResult, item, bestItem)
        || (isTie(result, bestResult, item, bestItem) && preferredOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Empty-slot test
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = normalizeSimResult(_deps.simulateCombatFn(
      emptyHypo, monster,
      buildSimOptions(baseSimOpts, emptyLoadout, { iterations: candidateIterations, seed: slotSeed }),
    ));
    if (isTank) {
      // Tank: only strip if empty has strictly higher win rate
      if (Number(emptyResult?.winRate ?? 0) > Number(bestResult?.winRate ?? 0)) {
        bestItem = null;
      }
    } else {
      // DPS: strip if empty deals more damage (lower monster HP %)
      const emptyMonHp = Number(emptyResult?.avgMonsterRemainingHpPercent ?? emptyResult?.monsterRemainingHpPercent ?? 100);
      const bestMonHp = Number(bestResult?.avgMonsterRemainingHpPercent ?? bestResult?.monsterRemainingHpPercent ?? 100);
      if (emptyMonHp < bestMonHp) {
        bestItem = null;
      }
    }

    loadout.set(slot, bestItem);
  }

  resetMultiSlotFamilyBaseline(loadout);

  // --- Phase 3: Accessories ---
  for (const slot of ACCESSORY_SLOTS) {
    const candidates = filterCandidates(filterDuplicateFamilyCandidates(
      getCandidatesForSlot(ctx, slot, bankItems, candidateOpts),
      slot, loadout, ctx, bankItems, candidateOpts,
    ));

    let bestResult = null;
    let bestItem = loadout.get(slot);
    const slotSeed = seedForSlot(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = normalizeSimResult(_deps.simulateCombatFn(
        hypo, monster,
        buildSimOptions(baseSimOpts, testLoadout, { iterations: candidateIterations, seed: slotSeed }),
      ));
      if (
        isBetter(result, bestResult, item, bestItem)
        || (isTie(result, bestResult, item, bestItem) && preferredOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Empty-slot test
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = normalizeSimResult(_deps.simulateCombatFn(
      emptyHypo, monster,
      buildSimOptions(baseSimOpts, emptyLoadout, { iterations: candidateIterations, seed: slotSeed }),
    ));
    if (isTank) {
      if (Number(emptyResult?.avgTurns || 0) > Number(bestResult?.avgTurns || 0)) {
        bestItem = null;
      }
    } else {
      const emptyMonHp = Number(emptyResult?.avgMonsterRemainingHpPercent ?? emptyResult?.monsterRemainingHpPercent ?? 100);
      const bestMonHp = Number(bestResult?.avgMonsterRemainingHpPercent ?? bestResult?.monsterRemainingHpPercent ?? 100);
      if (emptyMonHp < bestMonHp) {
        bestItem = null;
      }
    }

    loadout.set(slot, bestItem);
  }

  // --- Phase 4: Bag ---
  const bagCandidates = getCandidatesForSlot(ctx, 'bag', bankItems, candidateOpts);
  const bestBag = chooseBestBagCandidate(bagCandidates);
  if (bestBag?.item) {
    loadout.set('bag', bestBag.item);
  }

  // --- Final validation ---
  const finalStats = buildStats(baseStats, loadout);
  const finalSimOptions = buildSimOptions(baseSimOpts, loadout, {
    iterations: finalIterations,
    seed: seedForSlot('final'),
  });
  const finalResult = normalizeSimResult(_deps.simulateCombatFn(finalStats, monster, finalSimOptions));
  const gearThreat = computeGearThreat(loadout);

  // Convert to slot → itemCode map
  const codeLoadout = new Map();
  for (const [slot, item] of loadout) {
    codeLoadout.set(slot, item?.code || null);
  }

  // Log changes
  const changes = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const current = ctx.get()[`${slot}_slot`] || null;
    const optimal = codeLoadout.get(slot) || null;
    if (current !== optimal) {
      changes.push(`${slot}: ${current || '(empty)'} → ${optimal || '(empty)'}`);
    }
  }
  if (changes.length > 0) {
    log.debug(`[${ctx.name}] ${role} optimizer for ${monsterCode}: ${changes.join(', ')}${gearThreat ? ` (threat=${gearThreat})` : ''}`);
  }

  return { loadout: codeLoadout, simResult: finalResult, gearThreat };
}

/**
 * Find the best combat target considering gear optimization.
 * Evaluates each candidate monster with its optimal gear loadout.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @returns {Promise<{ monsterCode: string, monster: object, location: object, loadout: Map, simResult: object } | null>}
 */
export async function findBestCombatTarget(ctx) {
  const level = ctx.get().level;
  const monsters = _deps.findMonstersByLevelFn(level);
  if (monsters.length === 0) return null;

  let bestTarget = null;

  for (const monster of monsters) {
    if (monster?.type === 'boss') continue;

    if (gameData.isLocationUnreachable('monster', monster.code)) continue;
    const loc = await _deps.getMonsterLocationFn(monster.code);
    if (!loc) continue;

    const result = await optimizeForMonster(ctx, monster.code);
    if (!result || !isCombatResultViable(result.simResult)) continue;

    const candidate = {
      monsterCode: monster.code,
      monster,
      location: loc,
      loadout: result.loadout,
      simResult: result.simResult,
    };

    if (!bestTarget
      || monster.level > bestTarget.monster.level
      || (monster.level === bestTarget.monster.level
        && isBetterCombatResult(result.simResult, bestTarget.simResult))) {
      bestTarget = candidate;
    }
  }

  if (bestTarget) {
    log.info(`[${ctx.name}] Best target: ${bestTarget.monsterCode} (lv${bestTarget.monster.level}) — ${bestTarget.simResult.winRate.toFixed(1)}% win, need ${bestTarget.simResult.requiredHp ?? 'n/a'}hp`);
  } else {
    log.info(`[${ctx.name}] No beatable monster found with any gear combination`);
  }

  return bestTarget;
}

// --- Gathering gear optimizer ---
const GATHERING_NON_WEAPON_SLOTS = [
  'shield', 'helmet', 'body_armor', 'leg_armor', 'boots',
  'ring1', 'ring2', 'amulet', ...ARTIFACT_SLOTS, 'rune',
];

/**
 * Get the prospecting effect value from an item.
 * @returns {number} prospecting value (0 if none)
 */
function getProspecting(item) {
  if (!item?.effects) return 0;
  for (const e of item.effects) {
    if ((e.name || e.code) === 'prospecting') return e.value || 0;
  }
  return 0;
}

/**
 * Find the best available tool for a gathering skill.
 * A tool is a weapon with subtype "tool" and an effect matching the skill name.
 * Picks the highest-level tool the character can equip and has access to.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} skill
 * @param {Map<string, number>} bankItems
 * @returns {{ item: object, source: string } | null}
 */
function findBestTool(ctx, skill, bankItems) {
  const effectName = TOOL_EFFECT_BY_SKILL[skill];
  if (!effectName) return null;

  const char = ctx.get();
  const skillLevel = toPositiveInt(
    (typeof ctx.skillLevel === 'function' ? ctx.skillLevel(skill) : null)
    ?? char?.[`${skill}_level`]
    ?? char?.level,
  );
  const tools = _deps.findItemsFn({ type: 'weapon', subtype: 'tool', maxLevel: skillLevel })
    .filter(item =>
      item.effects?.some(e => (e.name || e.code) === effectName)
      && canUseItem(item, char),
    );

  if (tools.length === 0) return null;

  // Highest level first (better tier)
  tools.sort((a, b) => b.level - a.level);

  const equippedWeapon = ctx.get().weapon_slot || null;

  for (const tool of tools) {
    if (equippedWeapon === tool.code) return { item: tool, source: 'equipped' };
    if (ctx.hasItem(tool.code)) return { item: tool, source: 'inventory' };
    if (Math.max(_deps.bankCountFn(tool.code), bankItems?.get(tool.code) || 0) >= 1) return { item: tool, source: 'bank' };
  }

  return null;
}

/**
 * Find the optimal gathering loadout for a skill.
 * Weapon: best available tool for the skill.
 * Non-bag slots: maximize total prospecting stat.
 * Bag: maximize inventory_space.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} skill — gathering skill (mining, woodcutting, fishing, alchemy)
 * @returns {Promise<{ loadout: Map<string, string|null> } | null>}
 */
export async function optimizeForGathering(ctx, skill) {
  const bankItems = await _deps.getBankItemsFn();

  const toolResult = findBestTool(ctx, skill, bankItems);
  if (!toolResult) {
    log.warn(`[${ctx.name}] No tool found for ${skill}`);
    return null;
  }

  const loadout = new Map();
  loadout.set('weapon', toolResult.item.code);

  // For each non-weapon slot, pick the item with highest prospecting
  for (const slot of GATHERING_NON_WEAPON_SLOTS) {
    const candidates = filterDuplicateFamilyCandidates(
      getCandidatesForSlot(ctx, slot, bankItems),
      slot,
      loadout,
      ctx,
      bankItems,
    );
    const currentCode = ctx.get()[`${slot}_slot`] || null;

    let bestProspecting = 0;
    let bestCode = null;

    // Check current item's prospecting first
    if (currentCode) {
      const currentItem = _deps.getItemFn(currentCode);
      const currentAllowed = filterDuplicateFamilyCandidates(
        currentItem ? [{ item: currentItem, source: 'equipped' }] : [],
        slot,
        loadout,
        ctx,
        bankItems,
      ).length > 0;
      if (currentAllowed) {
        bestProspecting = getProspecting(currentItem);
        bestCode = currentCode;
      }
    }

    for (const { item } of candidates) {
      const p = getProspecting(item);
      if (p > bestProspecting) {
        bestProspecting = p;
        bestCode = item.code;
      }
    }

    // If no prospecting improvement, keep current gear
    loadout.set(slot, bestCode);
  }

  const bagCandidates = getCandidatesForSlot(ctx, 'bag', bankItems);
  const bestBag = chooseBestBagCandidate(bagCandidates);
  if (bestBag?.item?.code) {
    loadout.set('bag', bestBag.item.code);
  } else {
    loadout.set('bag', ctx.get().bag_slot || null);
  }

  // Log changes
  const changes = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const current = ctx.get()[`${slot}_slot`] || null;
    const optimal = loadout.get(slot) || null;
    if (current !== optimal) {
      changes.push(`${slot}: ${current || '(empty)'} → ${optimal || '(empty)'}`);
    }
  }

  if (changes.length > 0) {
    log.info(`[${ctx.name}] Gathering optimizer for ${skill}: ${changes.join(', ')}`);
  }

  return { loadout };
}

export function _chooseBestBagCandidateForTests(candidates = []) {
  const best = chooseBestBagCandidate(candidates);
  return best ? { ...best } : null;
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  _deps = {
    ..._deps,
    ...input,
  };
}

export function _resetDepsForTests() {
  _deps = {
    calcTurnDamageFn: calcTurnDamage,
    findRequiredHpForFightFn: findRequiredHpForFight,
    simulateCombatFn: simulateCombat,
    getMonsterFn: (code) => gameData.getMonster(code),
    getMonsterLocationFn: (code) => gameData.getMonsterLocation(code),
    findMonstersByLevelFn: (maxLevel) => gameData.findMonstersByLevel(maxLevel),
    getBankItemsFn: (forceRefresh = false) => gameData.getBankItems(forceRefresh),
    getItemFn: (code) => gameData.getItem(code),
    getEquipmentForSlotFn: (slot, charLevel) => gameData.getEquipmentForSlot(slot, charLevel),
    findItemsFn: (filters) => gameData.findItems(filters),
    findNpcForItemFn: (code) => gameData.findNpcForItem(code),
    bankCountFn: (code) => bankCount(code),
  };
}
