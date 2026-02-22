/**
 * Combat simulator — predicts fight outcomes using the documented
 * Artifacts MMO damage formulas. Pure math, no API calls.
 *
 * Formulas (from https://docs.artifactsmmo.com/concepts/stats_and_fights):
 *   Damage bonus:  Round(attack * damage_pct / 100)
 *   Resistance:    Round(attack * res_pct / 100)
 *   Critical:      1 stat = 1% chance for 1.5x total attack
 *   Initiative:    highest goes first; ties broken by HP, then random
 *   Max turns:     100 (timeout = loss)
 *
 * Supports monster effects (barrier, healing, reconstitution, poison, burn,
 * corrupted, berserker_rage, void_drain, protective_bubble, lifesteal, frenzy),
 * player utility effects (restore, antipoison), and player rune effects
 * (burn, lifesteal, healing, frenzy).
 */
import * as gameData from './game-data.mjs';
import * as log from '../log.mjs';

const ELEMENTS = ['fire', 'earth', 'water', 'air'];
const MAX_TURNS = 100;

// --- Damage calculation ---

/**
 * Calculate expected damage per turn from attacker to defender.
 * Uses expected-value crit (not random) for deterministic results.
 */
export function calcTurnDamage(attacker, defender) {
  return calcDamage(attacker, defender, 0, 0);
}

/**
 * Internal damage calc with modifier support.
 * @param {object} attacker
 * @param {object} defender
 * @param {number} resReduction — flat reduction subtracted from defender's resistance % (positive = less res)
 * @param {number} dmgBonus — bonus damage % added to attacker's dmg
 */
function calcDamage(attacker, defender, resReduction, dmgBonus) {
  let totalDmg = 0;

  for (const el of ELEMENTS) {
    const base = attacker[`attack_${el}`] || 0;
    if (base === 0) continue;

    const dmgPct = (attacker[`dmg_${el}`] || 0) + (attacker.dmg || 0) + dmgBonus;
    const boosted = base + Math.round(base * dmgPct / 100);

    const resPct = (defender[`res_${el}`] || 0) - resReduction;
    const reduction = Math.round(boosted * resPct / 100);

    totalDmg += Math.max(0, boosted - reduction);
  }

  const critChance = Math.min((attacker.critical_strike || 0) / 100, 1);
  totalDmg = Math.round(totalDmg * (1 + critChance * 0.5));

  return totalDmg;
}

/** Sum of all element base attacks. */
function sumAttack(stats) {
  let sum = 0;
  for (const el of ELEMENTS) sum += stats[`attack_${el}`] || 0;
  return sum;
}

// --- Effect parsing ---

function parseEffects(effectsArray) {
  const fx = {};
  for (const e of effectsArray || []) {
    const code = e.code || e.name;
    const value = Number(e.value) || 0;
    if (code && value) fx[code] = (fx[code] || 0) + value;
  }
  return fx;
}

function parseMonsterEffects(monster) {
  return parseEffects(monster?.effects);
}

function parseUtilityEffects(options) {
  const combined = {};
  for (const util of options?.utilities || []) {
    const fx = parseEffects(util?.effects);
    for (const [k, v] of Object.entries(fx)) {
      combined[k] = (combined[k] || 0) + v;
    }
  }
  return combined;
}

function parseRuneEffects(options) {
  return parseEffects(options?.rune?.effects);
}

function hasAnyEffect(monFx, utilFx, runeFx) {
  for (const fx of [monFx, utilFx, runeFx]) {
    for (const key in fx) if (fx[key]) return true;
  }
  return false;
}

// --- Initiative ---

function charGoesFirst(charStats, monsterStats) {
  const charInit = charStats.initiative || 0;
  const monInit = monsterStats.initiative || 0;
  if (charInit !== monInit) return charInit > monInit;
  return (charStats.max_hp || charStats.hp) >= monsterStats.hp;
}

// --- Result helper ---

function makeResult(win, turns, remainingHp, maxHp) {
  const hp = Math.max(0, remainingHp);
  return {
    win,
    turns,
    remainingHp: hp,
    hpLostPercent: ((maxHp - hp) / maxHp) * 100,
  };
}

// --- Simulation ---

/**
 * Simulate a fight turn-by-turn. Returns predicted outcome.
 *
 * @param {object} charStats — character stats (from API, includes equipment)
 * @param {object} monsterStats — monster stats (from game data cache)
 * @param {object} [options]
 * @param {Array<{code: string, effects: Array}>} [options.utilities] — equipped utility items
 * @param {{code: string, effects: Array}} [options.rune] — equipped rune item
 * @returns {{ win: boolean, turns: number, remainingHp: number, hpLostPercent: number }}
 */
export function simulateCombat(charStats, monsterStats, options = {}) {
  const monFx = parseMonsterEffects(monsterStats);
  const utilFx = parseUtilityEffects(options);
  const runeFx = parseRuneEffects(options);

  if (!hasAnyEffect(monFx, utilFx, runeFx)) {
    return simulateFastPath(charStats, monsterStats);
  }

  return simulateWithEffects(charStats, monsterStats, monFx, utilFx, runeFx);
}

/** Fast path — no effects, constant damage per turn. */
function simulateFastPath(charStats, monsterStats) {
  const charDmg = calcTurnDamage(charStats, monsterStats);
  const monsterDmg = calcTurnDamage(monsterStats, charStats);
  const first = charGoesFirst(charStats, monsterStats);

  let charHp = charStats.max_hp || charStats.hp;
  let monsterHp = monsterStats.hp;
  const maxHp = charHp;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const charTurn = first ? (turn % 2 === 1) : (turn % 2 === 0);

    if (charTurn) {
      monsterHp -= charDmg;
      if (monsterHp <= 0) return makeResult(true, turn, charHp, maxHp);
    } else {
      charHp -= monsterDmg;
      if (charHp <= 0) return makeResult(false, turn, 0, maxHp);
    }
  }

  return makeResult(false, MAX_TURNS, charHp, maxHp);
}

/**
 * Full simulation with effects — alternating individual turns.
 * Each loop iteration = 1 entity attacks (matching the API's turn model).
 */
function simulateWithEffects(charStats, monsterStats, monFx, utilFx, runeFx) {
  const charMaxHp = charStats.max_hp || charStats.hp;
  const monMaxHp = monsterStats.hp;
  let charHp = charMaxHp;
  let monHp = monMaxHp;
  const first = charGoesFirst(charStats, monsterStats);

  // Crit chances (for expected-value modeling of crit-triggered effects)
  const charCrit = Math.min((charStats.critical_strike || 0) / 100, 1);
  const monCrit = Math.min((monsterStats.critical_strike || 0) / 100, 1);

  // --- Monster effects applied to player ---
  const poisonDmg = Math.max(0, (monFx.poison || 0) - (utilFx.antipoison || 0));
  let playerBurnDmg = monFx.burn ? Math.round(sumAttack(monsterStats) * monFx.burn / 100) : 0;
  const corruptedPct = monFx.corrupted || 0;
  let corruptedStacks = 0;
  const berserkerPct = monFx.berserker_rage || 0;
  let berserkerActive = false;
  const barrierMax = monFx.barrier || 0;
  let barrierHp = barrierMax; // barrier starts at fight start
  // Protective bubble: +x% res to random element each turn. Model as avg +x/4% to all.
  const bubbleRes = monFx.protective_bubble ? monFx.protective_bubble / 4 : 0;

  // --- Player rune effects applied to monster ---
  let monBurnDmg = runeFx.burn ? Math.round(sumAttack(charStats) * runeFx.burn / 100) : 0;

  // --- Player utility ---
  const restoreHp = utilFx.restore || 0;
  let restoreUsed = false;

  // --- Expected-value frenzy damage bonuses ---
  const charFrenzyAvg = (runeFx.frenzy || 0) * charCrit;
  const monFrenzyAvg = (monFx.frenzy || 0) * monCrit;

  // Per-entity turn counters for periodic effects
  let charTurnCount = 0;
  let monTurnCount = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const isCharTurn = first ? (turn % 2 === 1) : (turn % 2 === 0);

    if (isCharTurn) {
      charTurnCount++;

      // --- Character's turn effects (before attack) ---

      // Poison tick (every char turn)
      if (poisonDmg > 0) {
        charHp -= poisonDmg;
        if (charHp <= 0) return makeResult(false, turn, 0, charMaxHp);
      }

      // Monster burn → player DoT (decays 10% each tick, integer floor — API-verified)
      if (playerBurnDmg > 0) {
        charHp -= playerBurnDmg;
        playerBurnDmg = Math.floor(playerBurnDmg * 0.9);
        if (charHp <= 0) return makeResult(false, turn, 0, charMaxHp);
      }

      // Player rune burn → monster DoT (bypasses barrier)
      if (monBurnDmg > 0) {
        monHp -= monBurnDmg;
        monBurnDmg = Math.floor(monBurnDmg * 0.9);
        // Don't check monster death — char attack follows
      }

      // Player rune healing (every 3 of char's turns)
      if (runeFx.healing && charTurnCount % 3 === 0) {
        charHp = Math.min(charMaxHp, charHp + Math.round(charMaxHp * runeFx.healing / 100));
      }

      // --- Character attacks ---
      const charDmg = calcDamage(charStats, monsterStats, -bubbleRes, charFrenzyAvg);
      let dmg = charDmg;
      if (barrierHp > 0) {
        const absorbed = Math.min(dmg, barrierHp);
        barrierHp -= absorbed;
        dmg -= absorbed;
      }
      monHp -= dmg;

      if (corruptedPct > 0) corruptedStacks++;

      // Player lifesteal (expected value: heal on crit)
      if (runeFx.lifesteal && charCrit > 0) {
        charHp = Math.min(charMaxHp, charHp + Math.round(charCrit * runeFx.lifesteal / 100 * sumAttack(charStats)));
      }

      // Check berserker rage trigger
      if (berserkerPct > 0 && !berserkerActive && monHp > 0 && monHp < monMaxHp * 0.25) {
        berserkerActive = true;
      }

      if (monHp <= 0) return makeResult(true, turn, charHp, charMaxHp);

      // Restore utility: one-shot heal when HP drops below 50%
      if (restoreHp > 0 && !restoreUsed && charHp < charMaxHp * 0.5) {
        charHp = Math.min(charMaxHp, charHp + restoreHp);
        restoreUsed = true;
      }
    } else {
      monTurnCount++;

      // --- Monster's turn effects (before attack) ---

      // Reconstitution: monster full heals at a specific monster-turn count
      if (monFx.reconstitution && monTurnCount === monFx.reconstitution) {
        monHp = monMaxHp;
      }

      // Monster healing (every 3 of monster's turns)
      if (monFx.healing && monTurnCount % 3 === 0) {
        monHp = Math.min(monMaxHp, monHp + Math.round(monMaxHp * monFx.healing / 100));
      }

      // Barrier refresh (every 5 of monster's turns)
      if (barrierMax > 0 && monTurnCount % 5 === 0) {
        barrierHp = barrierMax;
      }

      // Void drain (every 4 of monster's turns)
      if (monFx.void_drain && monTurnCount % 4 === 0) {
        const drained = Math.round(charHp * monFx.void_drain / 100);
        charHp -= drained;
        monHp = Math.min(monMaxHp, monHp + drained);
        if (charHp <= 0) return makeResult(false, turn, 0, charMaxHp);
      }

      // Protective bubble rotation happens each monster turn (modeled as avg)

      // --- Monster attacks ---
      const monDmgBonus = (berserkerActive ? berserkerPct : 0) + monFrenzyAvg;
      const monDmg = calcDamage(monsterStats, charStats, corruptedPct * corruptedStacks, monDmgBonus);
      charHp -= monDmg;

      // Monster lifesteal (expected value)
      if (monFx.lifesteal && monCrit > 0) {
        monHp = Math.min(monMaxHp, monHp + Math.round(monCrit * monFx.lifesteal / 100 * sumAttack(monsterStats)));
      }

      if (charHp <= 0) return makeResult(false, turn, 0, charMaxHp);

      // Restore utility: one-shot heal when HP drops below 50%
      if (restoreHp > 0 && !restoreUsed && charHp < charMaxHp * 0.5) {
        charHp = Math.min(charMaxHp, charHp + restoreHp);
        restoreUsed = true;
      }
    }
  }

  return makeResult(false, MAX_TURNS, charHp, charMaxHp);
}

// --- High-level helpers ---

// Track which monsters we've already logged simulation results for (per character)
// to avoid spamming logs on every canRun() check.
const loggedSims = new Map(); // "charName:monsterCode" → last result string

/**
 * Check whether a character can reliably beat a monster.
 * "Reliably" = simulation predicts a win with ≥10% HP remaining.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @returns {boolean}
 */
export function canBeatMonster(ctx, monsterCode) {
  const monster = gameData.getMonster(monsterCode);
  if (!monster) return false;

  const charStats = ctx.get();
  const result = simulateCombat(charStats, monster);

  // Log once per monster (or when result changes)
  const key = `${ctx.name}:${monsterCode}`;
  const summary = `${result.win ? 'WIN' : 'LOSS'} ${result.turns}t ${Math.round(result.remainingHp)}hp`;
  if (loggedSims.get(key) !== summary) {
    loggedSims.set(key, summary);
    const charDmg = calcTurnDamage(charStats, monster);
    const monsterDmg = calcTurnDamage(monster, charStats);
    log.info(`[${ctx.name}] Sim vs ${monsterCode}: ${summary} (char ${charDmg}/t, mob ${monsterDmg}/t)`);
  }

  return result.win && result.hpLostPercent <= 90; // win with ≥10% HP remaining
}

/**
 * Calculate the minimum HP needed to survive a fight against a monster.
 * Since combat is deterministic, damage taken is constant regardless of starting HP.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {string} monsterCode
 * @returns {number|null} — minimum HP needed, or null if the monster can't be beaten at full HP
 */
export function hpNeededForFight(ctx, monsterCode) {
  const monster = gameData.getMonster(monsterCode);
  if (!monster) return null;

  const charStats = ctx.get();
  const result = simulateCombat(charStats, monster);

  if (!result.win) return null;

  const damageTaken = charStats.max_hp - result.remainingHp;
  const critBuffer = Math.ceil(charStats.max_hp * 0.10); // 10% HP buffer for crit hits
  return damageTaken + critBuffer;
}
