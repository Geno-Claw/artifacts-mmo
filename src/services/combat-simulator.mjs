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
 */
import * as gameData from './game-data.mjs';
import * as log from '../log.mjs';

const ELEMENTS = ['fire', 'earth', 'water', 'air'];

/**
 * Calculate expected damage per turn from attacker to defender.
 * Uses expected-value crit (not random) for deterministic results.
 */
export function calcTurnDamage(attacker, defender) {
  let totalDmg = 0;

  for (const el of ELEMENTS) {
    const base = attacker[`attack_${el}`] || 0;
    if (base === 0) continue;

    // Characters have per-element dmg_* and a universal dmg bonus; monsters typically have neither
    const dmgPct = (attacker[`dmg_${el}`] || 0) + (attacker.dmg || 0);
    const boosted = base + Math.round(base * dmgPct / 100);

    const resPct = defender[`res_${el}`] || 0;
    const reduction = Math.round(boosted * resPct / 100);

    totalDmg += Math.max(0, boosted - reduction);
  }

  // Expected crit multiplier: critChance * 0.5 extra damage
  const critChance = Math.min((attacker.critical_strike || 0) / 100, 1);
  totalDmg = Math.round(totalDmg * (1 + critChance * 0.5));

  return totalDmg;
}

/**
 * Simulate a fight turn-by-turn. Returns predicted outcome.
 *
 * @param {object} charStats — character stats (from API, includes equipment)
 * @param {object} monsterStats — monster stats (from game data cache)
 * @returns {{ win: boolean, turns: number, remainingHp: number, hpLostPercent: number }}
 */
export function simulateCombat(charStats, monsterStats) {
  const charDmg = calcTurnDamage(charStats, monsterStats);
  const monsterDmg = calcTurnDamage(monsterStats, charStats);

  // Initiative: higher goes first. Ties: higher HP first.
  const charInit = charStats.initiative || 0;
  const monsterInit = monsterStats.initiative || 0;
  const charFirst = charInit > monsterInit
    || (charInit === monsterInit && (charStats.max_hp || charStats.hp) >= monsterStats.hp);

  let charHp = charStats.max_hp || charStats.hp;
  let monsterHp = monsterStats.hp;
  const maxHp = charHp;

  for (let turn = 1; turn <= 100; turn++) {
    if (charFirst) {
      monsterHp -= charDmg;
      if (monsterHp <= 0) {
        return { win: true, turns: turn, remainingHp: charHp, hpLostPercent: ((maxHp - charHp) / maxHp) * 100 };
      }
      charHp -= monsterDmg;
      if (charHp <= 0) {
        return { win: false, turns: turn, remainingHp: 0, hpLostPercent: 100 };
      }
    } else {
      charHp -= monsterDmg;
      if (charHp <= 0) {
        return { win: false, turns: turn, remainingHp: 0, hpLostPercent: 100 };
      }
      monsterHp -= charDmg;
      if (monsterHp <= 0) {
        return { win: true, turns: turn, remainingHp: charHp, hpLostPercent: ((maxHp - charHp) / maxHp) * 100 };
      }
    }
  }

  // 100 turns exceeded = automatic loss
  return { win: false, turns: 100, remainingHp: charHp, hpLostPercent: ((maxHp - charHp) / maxHp) * 100 };
}

// Track which monsters we've already logged simulation results for (per character)
// to avoid spamming logs on every canRun() check.
const loggedSims = new Map(); // "charName:monsterCode" → last result string

/**
 * Check whether a character can reliably beat a monster.
 * "Reliably" = simulation predicts a win with ≥20% HP remaining.
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

  return result.win && result.hpLostPercent <= 80; // win with ≥20% HP remaining
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
  return damageTaken + 1; // +1 so we don't end at exactly 0
}
