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
import { bankCount } from './inventory-manager.mjs';
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
export function getCandidatesForSlot(ctx, slot, bankItems) {
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
    const inBank = Math.max(bankCount(item.code), bankItems?.get(item.code) || 0);
    if (inBank >= 1) {
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
  if (!a.win && !b.win) return false; // Both losses — don't change gear
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
    const inBank = Math.max(bankCount(item.code), bankItems?.get(item.code) || 0);
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

// --- Gathering gear optimizer ---

/**
 * Skill-to-tool-effect mapping.
 * Tools are weapons (subtype "tool") whose effects include the gathering skill name.
 */
const SKILL_TO_TOOL_EFFECT = {
  mining: 'mining',
  woodcutting: 'woodcutting',
  fishing: 'fishing',
  alchemy: 'alchemy',
};

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
  const effectName = SKILL_TO_TOOL_EFFECT[skill];
  if (!effectName) return null;

  const charLevel = ctx.get().level;
  const tools = gameData.findItems({ type: 'weapon', subtype: 'tool', maxLevel: charLevel })
    .filter(item => item.effects?.some(e => (e.name || e.code) === effectName));

  if (tools.length === 0) return null;

  // Highest level first (better tier)
  tools.sort((a, b) => b.level - a.level);

  const equippedWeapon = ctx.get().weapon_slot || null;

  for (const tool of tools) {
    if (equippedWeapon === tool.code) return { item: tool, source: 'equipped' };
    if (ctx.hasItem(tool.code)) return { item: tool, source: 'inventory' };
    if (Math.max(bankCount(tool.code), bankItems?.get(tool.code) || 0) >= 1) return { item: tool, source: 'bank' };
  }

  return null;
}

/**
 * Find the optimal gathering loadout for a skill.
 * Weapon: best available tool for the skill.
 * All other slots: maximize total prospecting stat.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} skill — gathering skill (mining, woodcutting, fishing, alchemy)
 * @returns {Promise<{ loadout: Map<string, string|null> } | null>}
 */
export async function optimizeForGathering(ctx, skill) {
  const bankItems = await gameData.getBankItems();

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
      const currentItem = gameData.getItem(currentCode);
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
    const inBank = Math.max(bankCount(ring1Code), bankItems.get(ring1Code) || 0);
    if (equippedCount + inInventory + inBank < 2) {
      loadout.set('ring2', char.ring2_slot || null);
    }
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
