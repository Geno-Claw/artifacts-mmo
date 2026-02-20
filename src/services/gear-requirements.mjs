/**
 * Per-character gear requirements computation.
 *
 * Runs the optimizer against all reachable monsters, then uses greedy
 * knapsack packing to select the subset of gear that fits the carry budget
 * while maximising monster coverage.
 *
 * Pure algorithm — no module-level state.  All external services are
 * passed in via the `deps` parameter so callers can inject mocks.
 */
import { toPositiveInt } from '../utils.mjs';

const RESERVED_FREE_SLOTS = 10;
const CARRY_SLOT_PRIORITY = [
  'weapon', 'shield', 'helmet', 'body_armor', 'leg_armor',
  'boots', 'bag', 'amulet', 'ring1', 'ring2',
];
const UTILITY_SLOTS = ['utility1_slot', 'utility2_slot'];
const TOOL_SKILLS = ['mining', 'woodcutting', 'fishing', 'alchemy'];

// ── helpers ──────────────────────────────────────────────────────────

function countMapTotal(map) {
  let total = 0;
  for (const qty of map.values()) total += qty;
  return total;
}

export function maxMergeCounts(target, source) {
  for (const [code, qty] of source.entries()) {
    const current = target.get(code) || 0;
    if (qty > current) target.set(code, qty);
  }
}

function incrementCount(map, code, qty = 1) {
  const n = toPositiveInt(qty);
  if (!code || n <= 0) return;
  map.set(code, (map.get(code) || 0) + n);
}

function loadoutCodeForSlot(loadout, slot, fallbackChar = null) {
  if (loadout?.has(slot)) return loadout.get(slot) || null;
  if (slot === 'bag') return fallbackChar?.bag_slot || null;
  return null;
}

function countsFromLoadout(loadout, fallbackChar = null) {
  const counts = new Map();
  for (const slot of CARRY_SLOT_PRIORITY) {
    const code = loadoutCodeForSlot(loadout, slot, fallbackChar);
    if (!code) continue;
    incrementCount(counts, code, 1);
  }
  return counts;
}

function countsFromTrimmedLoadout(loadout, budget, fallbackChar = null) {
  const counts = new Map();
  let used = 0;

  for (const slot of CARRY_SLOT_PRIORITY) {
    if (used >= budget) break;
    const code = loadoutCodeForSlot(loadout, slot, fallbackChar);
    if (!code) continue;
    incrementCount(counts, code, 1);
    used += 1;
  }

  return counts;
}

function isCovered(required, owned) {
  for (const [code, qty] of required.entries()) {
    if ((owned.get(code) || 0) < qty) return false;
  }
  return true;
}

function extraNeeded(current, required) {
  const extra = new Map();
  for (const [code, qty] of required.entries()) {
    const have = current.get(code) || 0;
    if (have >= qty) continue;
    extra.set(code, qty - have);
  }
  return extra;
}

function mergeExtra(current, extra) {
  for (const [code, qty] of extra.entries()) {
    current.set(code, (current.get(code) || 0) + qty);
  }
}

function compareMonsterRecords(a, b) {
  if (a.level !== b.level) return b.level - a.level;
  if (a.turns !== b.turns) return a.turns - b.turns;
  return b.remainingHp - a.remainingHp;
}

// ── sub-requirement helpers ──────────────────────────────────────────

function computePotionRequirements(ctx, cfg) {
  const required = new Map();
  if (!cfg?.potionEnabled || !cfg?.potionTargetQty) return required;

  const char = ctx.get();
  for (const slot of UTILITY_SLOTS) {
    const code = char[slot] || null;
    if (!code) continue;
    incrementCount(required, code, cfg.potionTargetQty);
  }

  return required;
}

function computeToolRequirements(level, deps) {
  const required = new Map();
  const charLevel = toPositiveInt(level);
  if (charLevel <= 0) return required;

  for (const skill of TOOL_SKILLS) {
    const tool = deps.getBestToolForSkillAtLevelFn(skill, charLevel);
    if (!tool?.code) continue;
    incrementCount(required, tool.code, 1);
  }

  return required;
}

// ── main entry point ─────────────────────────────────────────────────

/**
 * Compute the full gear requirements for a single character.
 *
 * @param {string} name — character name (for logging)
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {{ potionEnabled: boolean, potionTargetQty: number }} cfg
 * @param {object} deps — injectable service functions
 * @param {object} deps.gameDataSvc — game data service (findMonstersByLevel)
 * @param {Function} deps.optimizeForMonsterFn — gear optimizer
 * @param {Function} deps.getBestToolForSkillAtLevelFn — tool policy
 * @param {Function} [deps.logFn] — optional logger
 * @returns {Promise<{ selected: Map, required: Map, selectedMonsters: string[], bestTarget: string|null, level: number }>}
 */
export async function computeCharacterRequirements(name, ctx, cfg, deps) {
  const char = ctx.get();
  const level = toPositiveInt(char.level);
  const capacity = Math.max(0, toPositiveInt(ctx.inventoryCapacity()));
  const carryBudget = Math.max(0, capacity - RESERVED_FREE_SLOTS);

  const allRecords = [];
  const monsters = deps.gameDataSvc.findMonstersByLevel(level);
  for (const monster of monsters) {
    const result = await deps.optimizeForMonsterFn(ctx, monster.code, {
      includeCraftableUnavailable: true,
    });
    if (!result?.simResult?.win) continue;
    if (result.simResult.hpLostPercent > 90) continue;

    allRecords.push({
      monsterCode: monster.code,
      level: toPositiveInt(monster.level),
      turns: toPositiveInt(result.simResult.turns),
      remainingHp: Number(result.simResult.remainingHp) || 0,
      loadout: result.loadout,
      counts: countsFromLoadout(result.loadout, char),
    });
  }

  allRecords.sort(compareMonsterRecords);

  const required = new Map();
  for (const record of allRecords) {
    maxMergeCounts(required, record.counts);
  }

  const potionRequired = computePotionRequirements(ctx, cfg);
  maxMergeCounts(required, potionRequired);
  const toolRequired = computeToolRequirements(level, deps);
  maxMergeCounts(required, toolRequired);

  const selected = new Map();
  const selectedMonsters = [];
  let bestTarget = null;

  if (allRecords.length > 0 && carryBudget > 0) {
    const best = allRecords[0];
    bestTarget = best.monsterCode;

    const baseCounts = countMapTotal(best.counts) > carryBudget
      ? countsFromTrimmedLoadout(best.loadout, carryBudget, char)
      : new Map(best.counts);

    maxMergeCounts(selected, baseCounts);

    const covered = new Set();
    for (const record of allRecords) {
      if (isCovered(record.counts, selected)) covered.add(record.monsterCode);
    }

    while (true) {
      const currentTotal = countMapTotal(selected);
      if (currentTotal >= carryBudget) break;

      let bestChoice = null;
      let bestExtra = null;
      let bestCoverage = -1;
      let bestExtraCost = Number.POSITIVE_INFINITY;

      for (const record of allRecords) {
        if (covered.has(record.monsterCode)) continue;

        const extra = extraNeeded(selected, record.counts);
        const extraCost = countMapTotal(extra);
        if (extraCost <= 0) {
          covered.add(record.monsterCode);
          continue;
        }
        if ((currentTotal + extraCost) > carryBudget) continue;

        const trial = new Map(selected);
        mergeExtra(trial, extra);

        let coverageGain = 0;
        for (const candidate of allRecords) {
          if (covered.has(candidate.monsterCode)) continue;
          if (isCovered(candidate.counts, trial)) coverageGain += 1;
        }

        const better =
          coverageGain > bestCoverage ||
          (coverageGain === bestCoverage && record.level > (bestChoice?.level || 0)) ||
          (coverageGain === bestCoverage && record.level === (bestChoice?.level || 0) && extraCost < bestExtraCost);

        if (better) {
          bestChoice = record;
          bestExtra = extra;
          bestCoverage = coverageGain;
          bestExtraCost = extraCost;
        }
      }

      if (!bestChoice || !bestExtra) break;

      mergeExtra(selected, bestExtra);
      for (const record of allRecords) {
        if (covered.has(record.monsterCode)) continue;
        if (isCovered(record.counts, selected)) covered.add(record.monsterCode);
      }
    }

    for (const record of allRecords) {
      if (isCovered(record.counts, selected)) selectedMonsters.push(record.monsterCode);
    }
  }

  // Potions are lower priority than gear but still part of desired ownership when room allows.
  if (carryBudget > 0) {
    const currentTotal = () => countMapTotal(selected);
    const potionEntries = [...potionRequired.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [code, qty] of potionEntries) {
      const have = selected.get(code) || 0;
      const need = Math.max(0, qty - have);
      if (need <= 0) continue;

      const remaining = Math.max(0, carryBudget - currentTotal());
      if (remaining <= 0) break;

      const addQty = Math.min(need, remaining);
      if (addQty <= 0) continue;
      selected.set(code, have + addQty);
    }
  }

  maxMergeCounts(selected, toolRequired);
  const selectedTotal = countMapTotal(selected);
  if (selectedTotal > carryBudget) {
    const logFn = deps.logFn || null;
    if (logFn) {
      logFn(
        `[GearRequirements] ${name}: selected ownership exceeds carry budget ` +
        `(${selectedTotal} > ${carryBudget}) after tool requirements`,
      );
    }
  }

  if (!bestTarget && allRecords.length > 0) {
    bestTarget = allRecords[0].monsterCode;
  }

  return {
    selected,
    required,
    selectedMonsters,
    bestTarget,
    level,
  };
}
