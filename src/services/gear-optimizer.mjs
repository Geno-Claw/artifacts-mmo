/**
 * Simulation-based combat gear optimizer.
 *
 * Evaluates equipment combinations using the combat simulator to find
 * the optimal loadout for a specific monster. Replaces the old static-weight
 * scoring system with fight-outcome-driven gear selection.
 *
 * Three-phase greedy approach:
 *   1. Weapon — maximize outgoing DPS (calcTurnDamage)
 *   2. Defensive slots — maximize survivability (simulateCombat → remainingHp)
 *   3. Accessories — maximize survivability (simulateCombat → remainingHp)
 */
import { calcTurnDamage, simulateCombat } from './combat-simulator.mjs';
import * as gameData from './game-data.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';
import * as log from '../log.mjs';

const DEFENSIVE_SLOTS = ['shield', 'helmet', 'body_armor', 'leg_armor', 'boots'];
const ACCESSORY_SLOTS = ['amulet', 'ring1', 'ring2'];

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

    const item = gameData.getItem(itemCode);
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

// --- Candidate collection ---

/**
 * Collect all available items for a slot from equipped, inventory, and bank.
 * Filtered by character level. Returns deduplicated by item code.
 */
function getCandidatesForSlot(ctx, slot, bankItems) {
  const char = ctx.get();
  const charLevel = char.level;
  const candidates = new Map(); // code → { item, source }

  // Currently equipped
  const equippedCode = char[`${slot}_slot`] || null;
  if (equippedCode) {
    const item = gameData.getItem(equippedCode);
    if (item) candidates.set(item.code, { item, source: 'equipped' });
  }

  // All items that fit this slot up to character level
  const allForSlot = gameData.getEquipmentForSlot(slot, charLevel);

  for (const item of allForSlot) {
    if (candidates.has(item.code)) continue;

    // Check inventory
    if (ctx.hasItem(item.code)) {
      candidates.set(item.code, { item, source: 'inventory' });
      continue;
    }

    // Check bank
    if (bankItems && (bankItems.get(item.code) || 0) >= 1) {
      candidates.set(item.code, { item, source: 'bank' });
    }
  }

  return [...candidates.values()];
}

// --- Comparison ---

/**
 * Is result A better than result B?
 * Priority: win > loss, then higher remainingHp, then fewer turns.
 */
function isBetterResult(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.win && !b.win) return true;
  if (!a.win && b.win) return false;
  if (a.remainingHp !== b.remainingHp) return a.remainingHp > b.remainingHp;
  return a.turns < b.turns;
}

// --- Ring deduplication ---

/**
 * For ring2: remove the ring1 item from candidates unless 2+ copies
 * exist across equipped + inventory + bank.
 */
function deduplicateRingCandidates(candidates, ring1Item, ctx, bankItems) {
  if (!ring1Item) return candidates;

  return candidates.filter(({ item }) => {
    if (item.code !== ring1Item.code) return true;

    // Count total copies across all sources
    const c = ctx.get();
    const equippedCount = [c.ring1_slot, c.ring2_slot]
      .filter(code => code === item.code).length;
    const inInventory = ctx.itemCount(item.code);
    const inBank = (bankItems?.get(item.code) || 0);
    return (equippedCount + inInventory + inBank) >= 2;
  });
}

// --- Main optimizer ---

/**
 * Find the optimal gear loadout for fighting a specific monster.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @returns {Promise<{ loadout: Map<string, string|null>, simResult: object } | null>}
 */
export async function optimizeForMonster(ctx, monsterCode) {
  const monster = gameData.getMonster(monsterCode);
  if (!monster) return null;

  const bankItems = await gameData.getBankItems();
  const baseStats = getBaseStats(ctx);

  // Start with current gear as baseline
  const loadout = new Map();
  for (const slot of EQUIPMENT_SLOTS) {
    const code = ctx.get()[`${slot}_slot`] || null;
    loadout.set(slot, code ? gameData.getItem(code) : null);
  }

  // --- Phase 1: Weapon (maximize outgoing DPS) ---
  const weaponCandidates = getCandidatesForSlot(ctx, 'weapon', bankItems);
  let bestWeaponDmg = -1;
  let bestWeapon = loadout.get('weapon');

  for (const { item } of weaponCandidates) {
    const testLoadout = new Map(loadout);
    testLoadout.set('weapon', item);
    const hypo = buildStats(baseStats, testLoadout);
    const dmg = calcTurnDamage(hypo, monster);
    if (dmg > bestWeaponDmg) {
      bestWeaponDmg = dmg;
      bestWeapon = item;
    }
  }
  loadout.set('weapon', bestWeapon);

  // --- Phase 2: Defensive slots (maximize survivability) ---
  for (const slot of DEFENSIVE_SLOTS) {
    const candidates = getCandidatesForSlot(ctx, slot, bankItems);
    let bestResult = null;
    let bestItem = loadout.get(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = simulateCombat(hypo, monster);
      if (isBetterResult(result, bestResult)) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = simulateCombat(emptyHypo, monster);
    if (isBetterResult(emptyResult, bestResult)) {
      bestItem = null;
    }

    loadout.set(slot, bestItem);
  }

  // --- Phase 3: Accessories (maximize survivability, full sim) ---
  for (const slot of ACCESSORY_SLOTS) {
    let candidates = getCandidatesForSlot(ctx, slot, bankItems);

    // Ring dedup: exclude ring1's choice from ring2 candidates
    if (slot === 'ring2') {
      candidates = deduplicateRingCandidates(candidates, loadout.get('ring1'), ctx, bankItems);
    }

    let bestResult = null;
    let bestItem = loadout.get(slot);

    for (const { item } of candidates) {
      const testLoadout = new Map(loadout);
      testLoadout.set(slot, item);
      const hypo = buildStats(baseStats, testLoadout);
      const result = simulateCombat(hypo, monster);
      if (isBetterResult(result, bestResult)) {
        bestResult = result;
        bestItem = item;
      }
    }

    // Also test empty slot
    const emptyLoadout = new Map(loadout);
    emptyLoadout.set(slot, null);
    const emptyHypo = buildStats(baseStats, emptyLoadout);
    const emptyResult = simulateCombat(emptyHypo, monster);
    if (isBetterResult(emptyResult, bestResult)) {
      bestItem = null;
    }

    loadout.set(slot, bestItem);
  }

  // --- Final validation ---
  const finalStats = buildStats(baseStats, loadout);
  const finalResult = simulateCombat(finalStats, monster);

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
    log.info(`[${ctx.name}] Gear optimizer vs ${monsterCode}: ${finalResult.win ? 'WIN' : 'LOSS'} ${finalResult.turns}t ${Math.round(finalResult.remainingHp)}hp | changes: ${changes.join(', ')}`);
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
  const monsters = gameData.findMonstersByLevel(level);
  if (monsters.length === 0) return null;

  let bestTarget = null;

  for (const monster of monsters) {
    const loc = await gameData.getMonsterLocation(monster.code);
    if (!loc) continue;

    const result = await optimizeForMonster(ctx, monster.code);
    if (!result || !result.simResult.win) continue;
    if (result.simResult.hpLostPercent > 80) continue; // need ≥20% HP remaining

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
