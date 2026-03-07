/**
 * Combat simulator — Monte Carlo combat viability using the documented
 * Artifacts MMO damage formulas.
 *
 * `simulateCombat()` is the production aggregate API.
 * `simulateCombatOnce()` runs a single randomized fight and is kept for
 * validation/testing and the Monte Carlo engine itself.
 */
import * as gameData from './game-data.mjs';
import * as log from '../log.mjs';
import { getCombatWinRateThreshold } from './combat-config.mjs';

const ELEMENTS = ['fire', 'earth', 'water', 'air'];
const MAX_TURNS = 100;
export const DEFAULT_MONTE_CARLO_ITERATIONS = 1000;
const SIM_RESULT_CACHE_LIMIT = 4000;
const SUPPORTED_MONSTER_EFFECTS = new Set([
  'barrier',
  'healing',
  'reconstitution',
  'poison',
  'burn',
  'corrupted',
  'berserker_rage',
  'void_drain',
  'protective_bubble',
  'lifesteal',
  'frenzy',
]);
const SUPPORTED_UTILITY_EFFECTS = new Set(['restore', 'antipoison']);
const SUPPORTED_RUNE_EFFECTS = new Set(['burn', 'lifesteal', 'healing', 'frenzy']);
const simResultCache = new Map();

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededRng(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function resolveThreshold(optionThreshold) {
  const threshold = Number(optionThreshold);
  if (Number.isFinite(threshold)) return clamp(threshold, 0, 100);
  return getCombatWinRateThreshold();
}

function resolveIterations(optionIterations) {
  const iterations = Number(optionIterations);
  if (!Number.isFinite(iterations) || iterations <= 0) return DEFAULT_MONTE_CARLO_ITERATIONS;
  return Math.max(1, Math.floor(iterations));
}

function normalizeStartingHp(charStats, startingHp) {
  const maxHp = Math.max(1, Number(charStats?.max_hp || charStats?.hp || 1));
  if (!Number.isFinite(Number(startingHp))) return maxHp;
  return clamp(Math.floor(Number(startingHp)), 0, maxHp);
}

function normalizeEffectsForSeed(effects) {
  return (effects || [])
    .map((effect) => ({
      code: effect?.code || effect?.name || '',
      value: Number(effect?.value) || 0,
    }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.value - b.value);
}

function pickSeedStats(stats) {
  if (!stats || typeof stats !== 'object') return null;

  const picked = {
    hp: Number(stats.hp || 0),
    max_hp: Number(stats.max_hp || 0),
    initiative: Number(stats.initiative || 0),
    critical_strike: Number(stats.critical_strike || 0),
    dmg: Number(stats.dmg || 0),
    effects: normalizeEffectsForSeed(stats.effects),
  };

  for (const element of ELEMENTS) {
    picked[`attack_${element}`] = Number(stats[`attack_${element}`] || 0);
    picked[`dmg_${element}`] = Number(stats[`dmg_${element}`] || 0);
    picked[`res_${element}`] = Number(stats[`res_${element}`] || 0);
  }

  return picked;
}

function buildSimulationSignature(charStats, monsterStats, options, iterations) {
  return JSON.stringify({
    char: pickSeedStats(charStats),
    monster: pickSeedStats(monsterStats),
    monsterEffects: parseMonsterEffects(monsterStats),
    utilityEffects: parseUtilityEffects(options),
    runeEffects: parseRuneEffects(options),
    iterations,
    startingHp: options?.startingHp ?? null,
    seed: Number.isFinite(Number(options?.seed)) ? Number(options.seed) : null,
  });
}

function buildDefaultSeed(charStats, monsterStats, options, iterations, threshold) {
  return hashString(buildSimulationSignature(charStats, monsterStats, options, iterations));
}

function buildAggregateBaseResult(results, iterations) {
  let wins = 0;
  let totalTurns = 0;
  let totalRemainingHp = 0;
  let totalHpLostPercent = 0;
  let totalHpLostOnWin = 0;

  for (const result of results) {
    totalTurns += Number(result.turns || 0);
    totalRemainingHp += Number(result.remainingHp || 0);
    totalHpLostPercent += Number(result.hpLostPercent || 0);
    if (result.win) {
      wins++;
      totalHpLostOnWin += Number(result.hpLost || 0);
    }
  }

  const losses = iterations - wins;
  return {
    iterations,
    wins,
    losses,
    winRate: (wins / iterations) * 100,
    avgTurns: totalTurns / iterations,
    avgRemainingHp: totalRemainingHp / iterations,
    avgHpLostPercent: totalHpLostPercent / iterations,
    avgHpLostOnWin: wins > 0 ? totalHpLostOnWin / wins : null,
  };
}

function materializeAggregateResult(baseResult, threshold) {
  const canWin = baseResult.winRate >= threshold;
  return {
    ...baseResult,
    canWin,
    threshold,
    // Legacy aliases used by downstream code/tests during migration.
    win: canWin,
    turns: baseResult.avgTurns,
    remainingHp: baseResult.avgRemainingHp,
    hpLostPercent: baseResult.avgHpLostPercent,
  };
}

function getCachedAggregateResult(cacheKey, threshold) {
  if (!simResultCache.has(cacheKey)) return null;
  const baseResult = simResultCache.get(cacheKey);
  // Refresh insertion order for simple LRU behavior.
  simResultCache.delete(cacheKey);
  simResultCache.set(cacheKey, baseResult);
  return materializeAggregateResult(baseResult, threshold);
}

function setCachedAggregateResult(cacheKey, baseResult) {
  simResultCache.set(cacheKey, baseResult);
  while (simResultCache.size > SIM_RESULT_CACHE_LIMIT) {
    const oldestKey = simResultCache.keys().next().value;
    if (!oldestKey) break;
    simResultCache.delete(oldestKey);
  }
}

function critChance(stats) {
  return clamp((Number(stats?.critical_strike) || 0) / 100, 0, 1);
}

function rollCrit(stats, rng) {
  return rng() < critChance(stats);
}

function elementAdjustment(adjustment, element) {
  if (adjustment && typeof adjustment === 'object') {
    return Number(adjustment[element] || 0);
  }
  return Number(adjustment || 0);
}

function calcDamageProfile(attacker, defender, resReduction = 0, dmgBonus = 0) {
  let baseDamage = 0;
  let critDamage = 0;

  for (const element of ELEMENTS) {
    const base = Number(attacker?.[`attack_${element}`] || 0);
    if (base === 0) continue;

    const dmgPct = Number(attacker?.[`dmg_${element}`] || 0) + Number(attacker?.dmg || 0) + dmgBonus;
    const boosted = base + Math.round(base * dmgPct / 100);

    const resPct = Number(defender?.[`res_${element}`] || 0) - elementAdjustment(resReduction, element);
    const reduction = Math.round(boosted * resPct / 100);
    const damage = Math.max(0, boosted - reduction);

    baseDamage += damage;
    critDamage += Math.round(damage * 1.5);
  }

  return { baseDamage, critDamage };
}

function calcBaseDamage(attacker, defender, resReduction = 0, dmgBonus = 0) {
  return calcDamageProfile(attacker, defender, resReduction, dmgBonus).baseDamage;
}

/**
 * Deterministic expected-value helper retained for logs and heuristics.
 */
export function calcTurnDamage(attacker, defender) {
  const profile = calcDamageProfile(attacker, defender, 0, 0);
  const critRate = critChance(attacker);
  return Math.round(profile.baseDamage + (profile.critDamage - profile.baseDamage) * critRate);
}

function calcRandomDamage(attacker, defender, rng, {
  resReduction = 0,
  dmgBonus = 0,
  crit = null,
} = {}) {
  const didCrit = typeof crit === 'boolean' ? crit : rollCrit(attacker, rng);
  const profile = calcDamageProfile(attacker, defender, resReduction, dmgBonus);
  return {
    damage: didCrit ? profile.critDamage : profile.baseDamage,
    baseDamage: profile.baseDamage,
    critDamage: profile.critDamage,
    crit: didCrit,
  };
}

function sumAttack(stats) {
  let sum = 0;
  for (const element of ELEMENTS) {
    sum += Number(stats?.[`attack_${element}`] || 0);
  }
  return sum;
}

function createElementMap(initialValue = 0) {
  return Object.fromEntries(ELEMENTS.map((element) => [element, initialValue]));
}

function attackElements(stats) {
  return ELEMENTS.filter((element) => Number(stats?.[`attack_${element}`] || 0) > 0);
}

function chooseBubbleElement(previousElement, rng) {
  const candidates = previousElement
    ? ELEMENTS.filter((element) => element !== previousElement)
    : ELEMENTS;
  return candidates[Math.floor(rng() * candidates.length)] || candidates[0] || null;
}

function parseEffects(effectsArray, allowedEffects = null) {
  const fx = {};
  for (const effect of effectsArray || []) {
    const code = effect?.code || effect?.name;
    const value = Number(effect?.value) || 0;
    if (!code || !value) continue;
    if (allowedEffects && !allowedEffects.has(code)) continue;
    fx[code] = (fx[code] || 0) + value;
  }
  return fx;
}

function parseMonsterEffects(monster) {
  return parseEffects(monster?.effects, SUPPORTED_MONSTER_EFFECTS);
}

function parseUtilityEffects(options) {
  const combined = {};
  for (const utility of options?.utilities || []) {
    const fx = parseEffects(utility?.effects, SUPPORTED_UTILITY_EFFECTS);
    for (const [key, value] of Object.entries(fx)) {
      combined[key] = (combined[key] || 0) + value;
    }
  }
  return combined;
}

function parseRuneEffects(options) {
  return parseEffects(options?.rune?.effects, SUPPORTED_RUNE_EFFECTS);
}

function hasAnyEffect(monFx, utilFx, runeFx) {
  for (const fx of [monFx, utilFx, runeFx]) {
    for (const key of Object.keys(fx)) {
      if (fx[key]) return true;
    }
  }
  return false;
}

function charGoesFirst(charStats, monsterStats, rng = Math.random, startingHp = null) {
  const charInit = Number(charStats?.initiative || 0);
  const monInit = Number(monsterStats?.initiative || 0);
  if (charInit !== monInit) return charInit > monInit;

  const charHp = startingHp == null
    ? Number(charStats?.max_hp || charStats?.hp || 0)
    : Number(startingHp || 0);
  const monHp = Number(monsterStats?.hp || 0);
  if (charHp !== monHp) return charHp > monHp;
  return rng() < 0.5;
}

function makeSingleFightResult(win, turns, remainingHp, maxHp) {
  const hp = Math.max(0, remainingHp);
  const safeMaxHp = Math.max(1, maxHp);
  return {
    win,
    turns,
    remainingHp: hp,
    hpLost: Math.max(0, safeMaxHp - hp),
    hpLostPercent: ((safeMaxHp - hp) / safeMaxHp) * 100,
  };
}

function simulateFastPathOnce(charStats, monsterStats, rng, startingHp) {
  const charHpStart = normalizeStartingHp(charStats, startingHp);
  const first = charGoesFirst(charStats, monsterStats, rng, charHpStart);
  const charMaxHp = Math.max(1, Number(charStats?.max_hp || charStats?.hp || 1));
  let charHp = charHpStart;
  let monsterHp = Math.max(1, Number(monsterStats?.hp || 1));

  const charProfile = calcDamageProfile(charStats, monsterStats, 0, 0);
  const monProfile = calcDamageProfile(monsterStats, charStats, 0, 0);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const isCharTurn = first ? (turn % 2 === 1) : (turn % 2 === 0);
    if (isCharTurn) {
      monsterHp -= rollCrit(charStats, rng) ? charProfile.critDamage : charProfile.baseDamage;
      if (monsterHp <= 0) return makeSingleFightResult(true, turn, charHp, charMaxHp);
    } else {
      charHp -= rollCrit(monsterStats, rng) ? monProfile.critDamage : monProfile.baseDamage;
      if (charHp <= 0) return makeSingleFightResult(false, turn, 0, charMaxHp);
    }
  }

  return makeSingleFightResult(false, MAX_TURNS, charHp, charMaxHp);
}

function simulateWithEffectsOnce(charStats, monsterStats, rng, {
  monFx,
  utilFx,
  runeFx,
  startingHp,
}) {
  const charMaxHp = Math.max(1, Number(charStats?.max_hp || charStats?.hp || 1));
  const monMaxHp = Math.max(1, Number(monsterStats?.hp || 1));
  let charHp = normalizeStartingHp(charStats, startingHp);
  let monHp = monMaxHp;
  const first = charGoesFirst(charStats, monsterStats, rng, charHp);

  const poisonDmg = Math.max(0, Number(monFx.poison || 0) - Number(utilFx.antipoison || 0));
  let playerBurnDmg = monFx.burn ? Math.round(sumAttack(monsterStats) * monFx.burn / 100) : 0;
  const corruptedPct = Number(monFx.corrupted || 0);
  const corruptedReduction = createElementMap(0);
  const berserkerPct = Number(monFx.berserker_rage || 0);
  let berserkerActive = false;
  const barrierMax = Number(monFx.barrier || 0);
  let barrierHp = barrierMax;
  const bubbleRes = Number(monFx.protective_bubble || 0);
  let bubbleElement = null;

  let monBurnDmg = runeFx.burn ? Math.round(sumAttack(charStats) * runeFx.burn / 100) : 0;

  const restoreHp = Number(utilFx.restore || 0);
  let restoreUsed = false;

  let charTurnCount = 0;
  let monTurnCount = 0;
  let charFrenzyReady = false;
  let monFrenzyReady = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const isCharTurn = first ? (turn % 2 === 1) : (turn % 2 === 0);

    if (isCharTurn) {
      charTurnCount++;

      if (poisonDmg > 0) {
        charHp -= poisonDmg;
        if (charHp <= 0) return makeSingleFightResult(false, turn, 0, charMaxHp);
      }

      if (playerBurnDmg > 0) {
        charHp -= playerBurnDmg;
        playerBurnDmg = Math.floor(playerBurnDmg * 0.9);
        if (charHp <= 0) return makeSingleFightResult(false, turn, 0, charMaxHp);
      }

      if (monBurnDmg > 0) {
        monHp -= monBurnDmg;
        monBurnDmg = Math.floor(monBurnDmg * 0.9);
      }

      if (runeFx.healing && charTurnCount % 3 === 0) {
        charHp = Math.min(charMaxHp, charHp + Math.round(charMaxHp * Number(runeFx.healing) / 100));
      }

      const didCrit = rollCrit(charStats, rng);
      const dmgBonus = charFrenzyReady ? Number(runeFx.frenzy || 0) : 0;
      charFrenzyReady = false;
      const resReduction = { ...corruptedReduction };
      if (bubbleElement) {
        resReduction[bubbleElement] -= bubbleRes;
      }
      let { damage } = calcRandomDamage(charStats, monsterStats, rng, {
        resReduction,
        dmgBonus,
        crit: didCrit,
      });

      if (barrierHp > 0) {
        const absorbed = Math.min(damage, barrierHp);
        barrierHp -= absorbed;
        damage -= absorbed;
      }

      const dealtDamage = Math.min(monHp, Math.max(0, damage));
      monHp -= damage;

      if (corruptedPct > 0) {
        for (const element of attackElements(charStats)) {
          corruptedReduction[element] += corruptedPct;
        }
      }

      if (runeFx.lifesteal && didCrit && dealtDamage > 0) {
        charHp = Math.min(charMaxHp, charHp + Math.round(Number(runeFx.lifesteal) / 100 * dealtDamage));
      }

      if (didCrit && runeFx.frenzy) {
        charFrenzyReady = true;
      }

      if (berserkerPct > 0 && !berserkerActive && monHp > 0 && monHp < monMaxHp * 0.25) {
        berserkerActive = true;
      }

      if (monHp <= 0) return makeSingleFightResult(true, turn, charHp, charMaxHp);

      if (restoreHp > 0 && !restoreUsed && charHp < charMaxHp * 0.5) {
        charHp = Math.min(charMaxHp, charHp + restoreHp);
        restoreUsed = true;
      }
    } else {
      monTurnCount++;

      if (bubbleRes > 0) {
        bubbleElement = chooseBubbleElement(bubbleElement, rng);
      }

      if (monFx.reconstitution && monTurnCount === Number(monFx.reconstitution)) {
        monHp = monMaxHp;
      }

      if (monFx.healing && monTurnCount % 3 === 0) {
        monHp = Math.min(monMaxHp, monHp + Math.round(monMaxHp * Number(monFx.healing) / 100));
      }

      if (barrierMax > 0 && monTurnCount % 5 === 0) {
        barrierHp = barrierMax;
      }

      if (monFx.void_drain && monTurnCount % 4 === 0) {
        const drained = Math.round(charHp * Number(monFx.void_drain) / 100);
        charHp -= drained;
        monHp = Math.min(monMaxHp, monHp + drained);
        if (charHp <= 0) return makeSingleFightResult(false, turn, 0, charMaxHp);
      }

      const didCrit = rollCrit(monsterStats, rng);
      const dmgBonus = (berserkerActive ? berserkerPct : 0) + (monFrenzyReady ? Number(monFx.frenzy || 0) : 0);
      monFrenzyReady = false;
      const { damage } = calcRandomDamage(monsterStats, charStats, rng, {
        resReduction: 0,
        dmgBonus,
        crit: didCrit,
      });
      const dealtDamage = Math.min(charHp, Math.max(0, damage));
      charHp -= damage;

      if (monFx.lifesteal && didCrit && dealtDamage > 0) {
        monHp = Math.min(monMaxHp, monHp + Math.round(Number(monFx.lifesteal) / 100 * dealtDamage));
      }

      if (didCrit && monFx.frenzy) {
        monFrenzyReady = true;
      }

      if (charHp <= 0) return makeSingleFightResult(false, turn, 0, charMaxHp);

      if (restoreHp > 0 && !restoreUsed && charHp < charMaxHp * 0.5) {
        charHp = Math.min(charMaxHp, charHp + restoreHp);
        restoreUsed = true;
      }
    }
  }

  return makeSingleFightResult(false, MAX_TURNS, charHp, charMaxHp);
}

export function simulateCombatOnce(charStats, monsterStats, options = {}) {
  const rng = typeof options.rng === 'function'
    ? options.rng
    : createSeededRng(toFiniteNumber(options.seed, 1));

  const monFx = parseMonsterEffects(monsterStats);
  const utilFx = parseUtilityEffects(options);
  const runeFx = parseRuneEffects(options);

  if (!hasAnyEffect(monFx, utilFx, runeFx)) {
    return simulateFastPathOnce(charStats, monsterStats, rng, options.startingHp);
  }

  return simulateWithEffectsOnce(charStats, monsterStats, rng, {
    monFx,
    utilFx,
    runeFx,
    startingHp: options.startingHp,
  });
}

function aggregateSimResult(results, iterations, threshold) {
  return materializeAggregateResult(buildAggregateBaseResult(results, iterations), threshold);
}

export function isBetterCombatResult(a, b) {
  if (!b) return true;
  if (!a) return false;
  const aCanWin = typeof a.canWin === 'boolean' ? a.canWin : Boolean(a.win);
  const bCanWin = typeof b.canWin === 'boolean' ? b.canWin : Boolean(b.win);
  if (aCanWin && !bCanWin) return true;
  if (!aCanWin && bCanWin) return false;
  const aWinRate = Number.isFinite(Number(a.winRate)) ? Number(a.winRate) : (aCanWin ? 100 : 0);
  const bWinRate = Number.isFinite(Number(b.winRate)) ? Number(b.winRate) : (bCanWin ? 100 : 0);
  if (aWinRate !== bWinRate) {
    return aWinRate > bWinRate;
  }

  const aRequiredHp = Number.isFinite(a.requiredHp) ? a.requiredHp : Number.POSITIVE_INFINITY;
  const bRequiredHp = Number.isFinite(b.requiredHp) ? b.requiredHp : Number.POSITIVE_INFINITY;
  if (aRequiredHp !== bRequiredHp) return aRequiredHp < bRequiredHp;
  if (Number(a.avgTurns || a.turns || 0) !== Number(b.avgTurns || b.turns || 0)) {
    return Number(a.avgTurns || a.turns || 0) < Number(b.avgTurns || b.turns || 0);
  }

  return Number(a.avgRemainingHp || a.remainingHp || 0) > Number(b.avgRemainingHp || b.remainingHp || 0);
}

export function isCombatResultTie(a, b) {
  if (!a || !b) return false;
  const aRequiredHp = Number.isFinite(a.requiredHp) ? a.requiredHp : Number.POSITIVE_INFINITY;
  const bRequiredHp = Number.isFinite(b.requiredHp) ? b.requiredHp : Number.POSITIVE_INFINITY;
  const aCanWin = typeof a.canWin === 'boolean' ? a.canWin : Boolean(a.win);
  const bCanWin = typeof b.canWin === 'boolean' ? b.canWin : Boolean(b.win);
  const aWinRate = Number.isFinite(Number(a.winRate)) ? Number(a.winRate) : (aCanWin ? 100 : 0);
  const bWinRate = Number.isFinite(Number(b.winRate)) ? Number(b.winRate) : (bCanWin ? 100 : 0);
  return aCanWin === bCanWin
    && aWinRate === bWinRate
    && aRequiredHp === bRequiredHp
    && Number(a.avgTurns || a.turns || 0) === Number(b.avgTurns || b.turns || 0)
    && Number(a.avgRemainingHp || a.remainingHp || 0) === Number(b.avgRemainingHp || b.remainingHp || 0);
}

export function simulateCombat(charStats, monsterStats, options = {}) {
  const iterations = resolveIterations(options.iterations);
  const threshold = resolveThreshold(options.threshold);
  const cacheKey = typeof options.rng === 'function'
    ? null
    : buildSimulationSignature(charStats, monsterStats, options, iterations);

  if (cacheKey) {
    const cached = getCachedAggregateResult(cacheKey, threshold);
    if (cached) return cached;
  }

  const rng = typeof options.rng === 'function'
    ? options.rng
    : createSeededRng(toFiniteNumber(
      options.seed,
      buildDefaultSeed(charStats, monsterStats, options, iterations, threshold),
    ));

  const perFightOptions = {
    ...options,
    threshold,
  };
  const results = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    results.push(simulateCombatOnce(charStats, monsterStats, {
      ...perFightOptions,
      rng,
    }));
  }

  const baseResult = buildAggregateBaseResult(results, iterations);
  if (cacheKey) {
    setCachedAggregateResult(cacheKey, baseResult);
  }
  return materializeAggregateResult(baseResult, threshold);
}

export function buildEquippedCombatOptions(ctx) {
  const char = typeof ctx?.get === 'function' ? ctx.get() : ctx;
  if (!char) return {};

  const options = {};
  const utilities = [];

  for (const slot of ['utility1', 'utility2']) {
    const code = char[`${slot}_slot`] || null;
    if (!code) continue;
    if (Number(char[`${slot}_slot_quantity`] || 0) <= 0) continue;
    const item = gameData.getItem(code);
    if (item?.effects?.length) {
      utilities.push({ code: item.code, effects: item.effects });
    }
  }

  if (utilities.length > 0) options.utilities = utilities;

  const runeCode = char.rune_slot || null;
  if (runeCode) {
    const rune = gameData.getItem(runeCode);
    if (rune?.effects?.length) {
      options.rune = { code: rune.code, effects: rune.effects };
    }
  }

  return options;
}

export const buildEquippedSimOptions = buildEquippedCombatOptions;

export function findRequiredHpForFight(charStats, monsterStats, options = {}) {
  const maxHp = Math.max(1, Number(charStats?.max_hp || charStats?.hp || 1));
  const threshold = resolveThreshold(options.threshold);
  const iterations = resolveIterations(options.iterations);
  const cache = new Map();

  const probe = (startingHp) => {
    const hp = clamp(Math.floor(startingHp), 1, maxHp);
    if (!cache.has(hp)) {
      cache.set(hp, simulateCombat(charStats, monsterStats, {
        ...options,
        iterations,
        threshold,
        startingHp: hp,
      }));
    }
    return cache.get(hp);
  };

  const fullHpResult = probe(maxHp);
  if (!fullHpResult.canWin) {
    return {
      requiredHp: null,
      threshold,
      iterations,
      fullHpResult,
    };
  }

  let low = 1;
  let high = maxHp;
  let best = maxHp;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const result = probe(mid);
    if (result.canWin) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return {
    requiredHp: best,
    threshold,
    iterations,
    fullHpResult,
    result: probe(best),
  };
}

export function isCombatResultViable(result) {
  if (typeof result?.canWin === 'boolean') return result.canWin;
  if (Number.isFinite(Number(result?.winRate))) {
    return Number(result.winRate) >= getCombatWinRateThreshold();
  }
  return Boolean(result?.win) && Number(result?.hpLostPercent ?? 100) <= 90;
}

const loggedSims = new Map();

export function canBeatMonster(ctx, monsterCode, options = {}) {
  const monster = gameData.getMonster(monsterCode);
  if (!monster) return false;

  const charStats = ctx.get();
  const simOptions = {
    ...buildEquippedCombatOptions(ctx),
    ...options,
  };
  const result = simulateCombat(charStats, monster, simOptions);

  const key = `${ctx.name}:${monsterCode}`;
  const summary = `${result.canWin ? 'GO' : 'SKIP'} ${Math.round(result.winRate)}% ${Math.round(result.avgTurns)}t ${Math.round(result.avgRemainingHp)}hp`;
  if (loggedSims.get(key) !== summary) {
    loggedSims.set(key, summary);
    const charDmg = calcTurnDamage(charStats, monster);
    const monsterDmg = calcTurnDamage(monster, charStats);
    log.info(`[${ctx.name}] Sim vs ${monsterCode}: ${summary} (char ${charDmg}/t, mob ${monsterDmg}/t)`);
  }

  return result.canWin;
}

export function hpNeededForFight(ctx, monsterCode, options = {}) {
  const monster = gameData.getMonster(monsterCode);
  if (!monster) return null;

  const result = findRequiredHpForFight(ctx.get(), monster, {
    ...buildEquippedCombatOptions(ctx),
    ...options,
  });
  return result.requiredHp;
}
