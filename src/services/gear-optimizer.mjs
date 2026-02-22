/**
 * Simulation-based combat gear optimizer.
 *
 * Evaluates equipment combinations using the combat simulator to find
 * the optimal loadout for a specific monster. Replaces the old static-weight
 * scoring system with fight-outcome-driven gear selection.
 *
 * Four-phase greedy approach:
 *   1. Weapon — maximize outgoing DPS (calcTurnDamage)
 *   2. Defensive slots — maximize survivability (simulateCombat → remainingHp)
 *   3. Accessories — maximize survivability (simulateCombat → remainingHp)
 *   4. Bag — maximize inventory space
 */
import { calcTurnDamage, simulateCombat } from './combat-simulator.mjs';
import * as gameData from './game-data.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';
import { bankCount } from './inventory-manager.mjs';
import { TOOL_EFFECT_BY_SKILL } from './tool-policy.mjs';
import * as log from '../log.mjs';

const DEFENSIVE_SLOTS = ['shield', 'helmet', 'body_armor', 'leg_armor', 'boots'];
const ACCESSORY_SLOTS = ['amulet', 'ring1', 'ring2'];

/**
 * Extract combat sim options (utilities/rune) from character state.
 * These stay constant during gear optimization — only equipment changes.
 */
function getSimOptions(ctx) {
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
  const runeCode = c.rune_slot;
  if (runeCode) {
    const item = _deps.getItemFn(runeCode);
    if (item?.effects) opts.rune = { code: runeCode, effects: item.effects };
  }
  return opts;
}

let _deps = {
  calcTurnDamageFn: calcTurnDamage,
  simulateCombatFn: simulateCombat,
  getMonsterFn: (code) => gameData.getMonster(code),
  getMonsterLocationFn: (code) => gameData.getMonsterLocation(code),
  findMonstersByLevelFn: (maxLevel) => gameData.findMonstersByLevel(maxLevel),
  getBankItemsFn: (forceRefresh = false) => gameData.getBankItems(forceRefresh),
  getItemFn: (code) => gameData.getItem(code),
  getEquipmentForSlotFn: (slot, charLevel) => gameData.getEquipmentForSlot(slot, charLevel),
  findItemsFn: (filters) => gameData.findItems(filters),
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

// --- Candidate collection ---

/**
 * Collect all available items for a slot from equipped, inventory, and bank.
 * Filtered by character level. Returns deduplicated by item code.
 */
export function getCandidatesForSlot(ctx, slot, bankItems, opts = {}) {
  const includeCraftableUnavailable = opts.includeCraftableUnavailable === true;
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

    // Check inventory
    if (ctx.hasItem(item.code)) {
      candidates.set(item.code, { item, source: 'inventory' });
      continue;
    }

    // Check bank
    const inBank = Math.max(_deps.bankCountFn(item.code), bankItems?.get(item.code) || 0);
    if (inBank >= 1) {
      candidates.set(item.code, { item, source: 'bank' });
      continue;
    }

    // Planning mode: include craftable items that are not yet owned.
    if (includeCraftableUnavailable && item?.craft?.skill) {
      candidates.set(item.code, { item, source: 'craftable' });
    }
  }

  return [...candidates.values()];
}

// --- Comparison ---

/**
 * Is result A better than result B?
 * Priority:
 *  - any win beats any loss
 *  - wins: higher remainingHp, then fewer turns
 *  - losses: higher remainingHp, then more turns (survive longer)
 */
function isBetterResult(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.win && !b.win) return true;
  if (!a.win && b.win) return false;
  if (a.remainingHp !== b.remainingHp) return a.remainingHp > b.remainingHp;
  if (a.win) return a.turns < b.turns;
  return a.turns > b.turns;
}

function isResultTie(a, b) {
  if (!a || !b) return false;
  return Boolean(a.win) === Boolean(b.win)
    && Number(a.remainingHp || 0) === Number(b.remainingHp || 0)
    && Number(a.turns || 0) === Number(b.turns || 0);
}

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

// --- Ring deduplication ---

/**
 * For ring2: remove the ring1 item from candidates unless 2+ copies
 * exist across equipped + inventory + bank.
 */
function deduplicateRingCandidates(candidates, ring1Item, ctx, bankItems, opts = {}) {
  const includeCraftableUnavailable = opts.includeCraftableUnavailable === true;
  if (!ring1Item) return candidates;

  return candidates.filter(({ item, source }) => {
    if (item.code !== ring1Item.code) return true;

    // Planning mode can assume missing craftable duplicates can be crafted.
    if (includeCraftableUnavailable && source === 'craftable') return true;

    // Count total copies across all sources
    const c = ctx.get();
    const equippedCount = [c.ring1_slot, c.ring2_slot]
      .filter(code => code === item.code).length;
    const inInventory = ctx.itemCount(item.code);
    const inBank = Math.max(_deps.bankCountFn(item.code), bankItems?.get(item.code) || 0);
    return (equippedCount + inInventory + inBank) >= 2;
  });
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
  };
  const monster = _deps.getMonsterFn(monsterCode);
  if (!monster) return null;

  const bankItems = await _deps.getBankItemsFn();
  const baseStats = getBaseStats(ctx);
  const simOpts = getSimOptions(ctx);

  // Start with current gear as baseline
  const loadout = new Map();
  for (const slot of EQUIPMENT_SLOTS) {
    const code = ctx.get()[`${slot}_slot`] || null;
    loadout.set(slot, code ? _deps.getItemFn(code) : null);
  }

  // --- Phase 1: Weapon (maximize outgoing DPS) ---
  const weaponCandidates = getCandidatesForSlot(ctx, 'weapon', bankItems, candidateOpts);
  let bestWeaponDmg = -1;
  let bestWeapon = loadout.get('weapon');

  for (const { item } of weaponCandidates) {
    const testLoadout = new Map(loadout);
    testLoadout.set('weapon', item);
    const hypo = buildStats(baseStats, testLoadout);
    const dmg = _deps.calcTurnDamageFn(hypo, monster);
    if (dmg > bestWeaponDmg || (dmg === bestWeaponDmg && isPreferredItemOnTie(item, bestWeapon))) {
      bestWeaponDmg = dmg;
      bestWeapon = item;
    }
  }
  loadout.set('weapon', bestWeapon);

  // --- Phase 2: Defensive slots (maximize survivability) ---
  for (const slot of DEFENSIVE_SLOTS) {
    const candidates = getCandidatesForSlot(ctx, slot, bankItems, candidateOpts);
    let bestResult = null;
    let bestItem = loadout.get(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = _deps.simulateCombatFn(hypo, monster, simOpts);
      if (
        isBetterResult(result, bestResult)
        || (isResultTie(result, bestResult) && isPreferredItemOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = _deps.simulateCombatFn(emptyHypo, monster, simOpts);
    if (isBetterResult(emptyResult, bestResult)) {
      bestItem = null;
    }

    loadout.set(slot, bestItem);
  }

  // --- Phase 3: Accessories (maximize survivability, full sim) ---
  for (const slot of ACCESSORY_SLOTS) {
    let candidates = getCandidatesForSlot(ctx, slot, bankItems, candidateOpts);

    // Ring dedup: exclude ring1's choice from ring2 candidates
    if (slot === 'ring2') {
      candidates = deduplicateRingCandidates(candidates, loadout.get('ring1'), ctx, bankItems, candidateOpts);
    }

    let bestResult = null;
    let bestItem = loadout.get(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = _deps.simulateCombatFn(hypo, monster, simOpts);
      if (
        isBetterResult(result, bestResult)
        || (isResultTie(result, bestResult) && isPreferredItemOnTie(item, bestItem))
      ) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = _deps.simulateCombatFn(emptyHypo, monster, simOpts);
    if (isBetterResult(emptyResult, bestResult)) {
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
  const finalResult = _deps.simulateCombatFn(finalStats, monster, simOpts);

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

  return { loadout: codeLoadout, simResult: finalResult };
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
    if (gameData.isLocationUnreachable('monster', monster.code)) continue;
    const loc = await _deps.getMonsterLocationFn(monster.code);
    if (!loc) continue;

    const result = await optimizeForMonster(ctx, monster.code);
    if (!result || !result.simResult.win) continue;
    if (result.simResult.hpLostPercent > 90) continue; // need ≥10% HP remaining

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
        && result.simResult.turns < bestTarget.simResult.turns)
      || (monster.level === bestTarget.monster.level
        && result.simResult.turns === bestTarget.simResult.turns
        && result.simResult.remainingHp > bestTarget.simResult.remainingHp)) {
      bestTarget = candidate;
    }
  }

  if (bestTarget) {
    log.info(`[${ctx.name}] Best target: ${bestTarget.monsterCode} (lv${bestTarget.monster.level}) — ${bestTarget.simResult.turns}t, ${Math.round(bestTarget.simResult.remainingHp)}hp remaining`);
  } else {
    log.info(`[${ctx.name}] No beatable monster found with any gear combination`);
  }

  return bestTarget;
}

// --- Gathering gear optimizer ---


const NON_WEAPON_SLOTS = ['shield', 'helmet', 'body_armor', 'leg_armor', 'boots', 'ring1', 'ring2', 'amulet'];

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

  const charLevel = ctx.get().level;
  const tools = _deps.findItemsFn({ type: 'weapon', subtype: 'tool', maxLevel: charLevel })
    .filter(item => item.effects?.some(e => (e.name || e.code) === effectName));

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
  for (const slot of NON_WEAPON_SLOTS) {
    const candidates = getCandidatesForSlot(ctx, slot, bankItems);
    const currentCode = ctx.get()[`${slot}_slot`] || null;

    let bestProspecting = 0;
    let bestCode = null;

    // Check current item's prospecting first
    if (currentCode) {
      const currentItem = _deps.getItemFn(currentCode);
      bestProspecting = getProspecting(currentItem);
      bestCode = currentCode;
    }

    for (const { item } of candidates) {
      const p = getProspecting(item);
      if (p > bestProspecting) {
        bestProspecting = p;
        bestCode = item.code;
      }
    }

    // If no prospecting improvement, keep current gear
    loadout.set(slot, bestCode || currentCode);
  }

  // Ring deduplication: if both rings chose same item, check we have 2 copies
  const ring1Code = loadout.get('ring1');
  const ring2Code = loadout.get('ring2');
  if (ring1Code && ring1Code === ring2Code) {
    const char = ctx.get();
    const equippedCount = [char.ring1_slot, char.ring2_slot].filter(c => c === ring1Code).length;
    const inInventory = ctx.itemCount(ring1Code);
    const inBank = Math.max(_deps.bankCountFn(ring1Code), bankItems.get(ring1Code) || 0);
    if (equippedCount + inInventory + inBank < 2) {
      loadout.set('ring2', char.ring2_slot || null);
    }
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
    simulateCombatFn: simulateCombat,
    getMonsterFn: (code) => gameData.getMonster(code),
    getMonsterLocationFn: (code) => gameData.getMonsterLocation(code),
    findMonstersByLevelFn: (maxLevel) => gameData.findMonstersByLevel(maxLevel),
    getBankItemsFn: (forceRefresh = false) => gameData.getBankItems(forceRefresh),
    getItemFn: (code) => gameData.getItem(code),
    getEquipmentForSlotFn: (slot, charLevel) => gameData.getEquipmentForSlot(slot, charLevel),
    findItemsFn: (filters) => gameData.findItems(filters),
    bankCountFn: (code) => bankCount(code),
  };
}
