/**
 * Event Simulation Service — evaluates characters against event monsters
 * using the server-side combat simulation API.
 *
 * Falls back to the local combat simulator if the API is unavailable
 * (non-member account, network error, etc.).
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { canBeatMonster } from './combat-simulator.mjs';

const TAG = '[EventSim]';

const DEFAULT_ITERATIONS = 10;
const DEFAULT_MIN_WINRATE = 80;

/** Cache: "charName:monsterCode:level:equipHash" → { canWin, winrate, avgTurns, cachedAt } */
const simCache = new Map();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor', 'leg_armor', 'boots',
  'ring1', 'ring2', 'amulet', 'artifact1', 'artifact2', 'artifact3',
  'utility1', 'utility2', 'rune',
];

/**
 * Build a FakeCharacter object from a CharacterContext for the simulation API.
 */
export function buildFakeCharacter(ctx) {
  const char = ctx.get();
  const fake = { level: char.level };

  for (const slot of EQUIPMENT_SLOTS) {
    const code = char[`${slot}_slot`] || null;
    if (code) {
      fake[`${slot}_slot`] = code;
    }
  }

  // Include utility quantities if equipped
  if (char.utility1_slot) {
    fake.utility1_slot_quantity = char.utility1_slot_quantity || 1;
  }
  if (char.utility2_slot) {
    fake.utility2_slot_quantity = char.utility2_slot_quantity || 1;
  }

  return fake;
}

/**
 * Generate a cache key from character state.
 */
function cacheKey(ctx, monsterCode) {
  const char = ctx.get();
  const equipCodes = EQUIPMENT_SLOTS.map(s => char[`${s}_slot`] || '').join(':');
  return `${ctx.name}:${monsterCode}:${char.level}:${equipCodes}`;
}

/**
 * Evaluate whether a character can beat an event monster.
 *
 * Uses the server-side simulation API with caching.
 * Falls back to local combat-simulator.mjs if the API is unavailable.
 *
 * @param {CharacterContext} ctx
 * @param {string} monsterCode
 * @param {{ iterations?: number, minWinrate?: number }} options
 * @returns {Promise<{ canWin: boolean, winrate: number, avgTurns: number, source: 'api'|'local' }>}
 */
export async function canCharacterBeatEvent(ctx, monsterCode, {
  iterations = DEFAULT_ITERATIONS,
  minWinrate = DEFAULT_MIN_WINRATE,
} = {}) {
  // Check cache
  const key = cacheKey(ctx, monsterCode);
  const cached = simCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  // Try server-side simulation API
  try {
    const fakeChar = buildFakeCharacter(ctx);
    const response = await api.simulateFight({
      characters: [fakeChar],
      monster: monsterCode,
      iterations,
    });

    const data = response;
    const winrate = data.winrate ?? 0;
    const avgTurns = data.results?.length > 0
      ? data.results.reduce((sum, r) => sum + r.turns, 0) / data.results.length
      : 0;

    const result = {
      canWin: winrate >= minWinrate,
      winrate,
      avgTurns: Math.round(avgTurns),
      source: 'api',
    };

    simCache.set(key, { result, cachedAt: Date.now() });
    log.info(`${TAG} ${ctx.name} vs ${monsterCode}: ${winrate}% winrate (${iterations} iters) → ${result.canWin ? 'GO' : 'SKIP'}`);
    return result;
  } catch (err) {
    log.warn(`${TAG} Simulation API failed for ${ctx.name} vs ${monsterCode}: ${err.message}. Falling back to local sim.`);
  }

  // Fallback: local combat simulator
  const canWin = canBeatMonster(ctx, monsterCode);
  const result = {
    canWin,
    winrate: canWin ? 100 : 0,
    avgTurns: 0,
    source: 'local',
  };

  simCache.set(key, { result, cachedAt: Date.now() });
  log.info(`${TAG} ${ctx.name} vs ${monsterCode}: local sim → ${canWin ? 'GO' : 'SKIP'}`);
  return result;
}

/**
 * Clear simulation cache (e.g., on level-up or gear change).
 */
export function clearCache(charName) {
  if (!charName) {
    simCache.clear();
    return;
  }
  for (const key of simCache.keys()) {
    if (key.startsWith(`${charName}:`)) {
      simCache.delete(key);
    }
  }
}

/**
 * Evaluate best team of up to 3 characters against a boss monster.
 * Framework for V2 — not called in V1.
 *
 * @param {CharacterContext[]} contexts - all available character contexts
 * @param {string} monsterCode
 * @param {{ iterations?: number }} options
 * @returns {Promise<{ team: CharacterContext[], winrate: number } | null>}
 */
export async function findBestTeam(contexts, monsterCode, { iterations = DEFAULT_ITERATIONS } = {}) {
  if (contexts.length < 1) return null;

  const candidates = contexts.slice(0, 5); // max 5 characters
  let bestTeam = null;
  let bestWinrate = -1;

  // Try all combinations of 3 (or fewer if not enough characters)
  const teamSize = Math.min(3, candidates.length);
  const combos = combinations(candidates, teamSize);

  for (const team of combos) {
    try {
      const fakeChars = team.map(ctx => buildFakeCharacter(ctx));
      const response = await api.simulateFight({
        characters: fakeChars,
        monster: monsterCode,
        iterations,
      });

      const winrate = response.winrate ?? 0;
      if (winrate > bestWinrate) {
        bestWinrate = winrate;
        bestTeam = team;
      }
    } catch (err) {
      log.warn(`${TAG} Team simulation failed: ${err.message}`);
    }
  }

  if (!bestTeam) return null;

  log.info(`${TAG} Best team for ${monsterCode}: ${bestTeam.map(c => c.name).join(', ')} (${bestWinrate}% winrate)`);
  return { team: bestTeam, winrate: bestWinrate };
}

/** Generate all combinations of size k from an array. */
function combinations(arr, k) {
  if (k === 1) return arr.map(x => [x]);
  const result = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const rest = combinations(arr.slice(i + 1), k - 1);
    for (const combo of rest) {
      result.push([arr[i], ...combo]);
    }
  }
  return result;
}

// --- Testing helpers ---
export { simCache as _simCache };
