/**
 * Boss Rally — coordination service for group boss fights.
 *
 * Module-level singleton state machine. All characters in the same Node.js
 * process share one rally at a time. Uses CAS semantics (tryCreateRally)
 * to prevent race conditions between concurrent character schedulers.
 *
 * Phases: IDLE → RALLYING → READY → FIGHTING → DONE/FAILED
 */
import * as log from '../log.mjs';

const TAG = '[BossRally]';
const DEFAULT_LEASE_TTL_MS = 10 * 60_000; // 10 minutes

// --- Context registry ---
const contexts = new Map(); // name → CharacterContext
const enabledBossesMap = new Map(); // name → Set<bossCode>

export function registerContext(ctx) {
  contexts.set(ctx.name, ctx);
}

export function unregisterContext(name) {
  contexts.delete(name);
  enabledBossesMap.delete(name);
}

export function getAllContexts() {
  return [...contexts.values()];
}

export function getContext(name) {
  return contexts.get(name) || null;
}

/**
 * Register which bosses a character has enabled in their config.
 * Called by BossFightRoutine.canRun() to keep the registry current.
 */
export function registerEnabledBosses(name, bossCodes) {
  enabledBossesMap.set(name, new Set(bossCodes));
}

export function unregisterEnabledBosses(name) {
  enabledBossesMap.delete(name);
}

/**
 * Get eligible contexts for a boss rally.
 * Eligible = not on cooldown, inventory not full, not already in an active rally.
 * If bossCode is provided, also filters to characters with that boss enabled.
 */
export function getEligibleContexts({ enabledNames, bossCode, ignoreCooldown = false }) {
  cleanup();
  const eligible = [];
  const enabledSet = new Set(enabledNames);
  for (const ctx of contexts.values()) {
    if (!enabledSet.has(ctx.name)) continue;
    if (!ignoreCooldown && ctx.cooldownRemainingMs() > 0) continue;
    if (ctx.inventoryFull()) continue;
    if (rally && isParticipantUnchecked(ctx.name)) continue;
    if (bossCode) {
      const charBosses = enabledBossesMap.get(ctx.name);
      if (!charBosses || !charBosses.has(bossCode)) continue;
    }
    eligible.push(ctx);
  }
  return eligible;
}

// --- Evaluation lock ---
let evaluating = null; // { name, startedAt } or null
const EVAL_TIMEOUT_MS = 60_000;

/**
 * CAS: claim the evaluation lock. Only one character evaluates at a time.
 * Returns true if this character acquired the lock, false otherwise.
 */
export function tryStartEvaluation(name) {
  if (rally) return false;
  if (evaluating) {
    if ((Date.now() - evaluating.startedAt) > EVAL_TIMEOUT_MS) {
      log.warn(`${TAG} Evaluation lock held by ${evaluating.name} timed out after ${EVAL_TIMEOUT_MS}ms, overriding`);
    } else {
      return false;
    }
  }
  evaluating = { name, startedAt: Date.now() };
  return true;
}

/**
 * Release the evaluation lock. Idempotent — only clears if held by the given name.
 */
export function endEvaluation(name) {
  if (evaluating?.name === name) {
    evaluating = null;
  }
}

/**
 * Returns true if an evaluation is currently in progress and not timed out.
 * Cleans up stale locks as a side effect.
 */
export function isEvaluating() {
  if (!evaluating) return false;
  if ((Date.now() - evaluating.startedAt) > EVAL_TIMEOUT_MS) {
    log.warn(`${TAG} Stale evaluation lock by ${evaluating.name}, clearing`);
    evaluating = null;
    return false;
  }
  return true;
}

// --- Rally state ---
let rally = null;

function cleanup() {
  if (rally && (Date.now() - rally.createdAt) > rally.leaseTtlMs) {
    log.warn(`${TAG} Rally timed out after ${rally.leaseTtlMs}ms, cancelling`);
    for (const name of [rally.leaderName, ...rally.participants]) {
      const ctx = contexts.get(name);
      if (ctx && typeof ctx.clearRoutineKeepCodes === 'function') {
        ctx.clearRoutineKeepCodes();
      }
    }
    rally = null;
  }
}

/**
 * Try to create a new rally (CAS — only succeeds if no rally is active).
 * @returns {object|null} The new rally, or null if one already exists.
 */
export function tryCreateRally({ bossCode, location, leaderName, participants, loadouts, roles, leaseTtlMs }) {
  cleanup();
  if (rally) return null;

  rally = {
    bossCode,
    location,
    leaderName,
    participants: [...participants],
    phase: 'rallying',
    checkedIn: new Set(),
    createdAt: Date.now(),
    leaseTtlMs: leaseTtlMs || DEFAULT_LEASE_TTL_MS,
    fightResult: null,
    loadouts: loadouts || new Map(),
    roles: roles || new Map(),
    resultConsumedBy: new Set(),
    fightCount: 0,
  };

  const roleDesc = rally.roles.size > 0
    ? ` (${[...rally.roles].map(([n, r]) => `${n}=${r}`).join(', ')})`
    : '';
  log.info(`${TAG} Rally created: ${leaderName} leads [${participants.join(', ')}] vs ${bossCode}${roleDesc}`);
  return rally;
}

export function getRally() {
  cleanup();
  return rally;
}

export function isRallyActive() {
  cleanup();
  return rally !== null;
}

function isParticipantUnchecked(name) {
  return rally && (rally.leaderName === name || rally.participants.includes(name));
}

export function isParticipant(name) {
  cleanup();
  return isParticipantUnchecked(name);
}

export function checkIn(name) {
  cleanup();
  if (!rally) return;
  rally.checkedIn.add(name);
  log.info(`${TAG} ${name} checked in (${rally.checkedIn.size}/${1 + rally.participants.length})`);
}

export function allCheckedIn() {
  cleanup();
  if (!rally) return false;
  const allNames = [rally.leaderName, ...rally.participants];
  return allNames.every(n => rally.checkedIn.has(n));
}

export function setPhase(phase) {
  cleanup();
  if (!rally) return;
  log.info(`${TAG} Phase: ${rally.phase} → ${phase}`);
  rally.phase = phase;
}

export function setFightResult(result) {
  if (!rally) return;
  rally.fightResult = result;
}

export function markResultConsumed(name) {
  if (!rally) return;
  rally.resultConsumedBy.add(name);
}

export function allResultsConsumed() {
  cleanup();
  if (!rally) return true;
  const allNames = [rally.leaderName, ...rally.participants];
  return allNames.every(n => rally.resultConsumedBy.has(n));
}

/**
 * Reset the rally for the next fight without tearing down team/gear/location.
 * Clears check-ins and fight result, increments fight count, resets TTL.
 * @returns {boolean} true if reset succeeded, false if no rally.
 */
export function resetForNextFight() {
  if (!rally) return false;
  rally.checkedIn = new Set();
  rally.fightResult = null;
  rally.resultConsumedBy = new Set();
  rally.fightCount = (rally.fightCount || 0) + 1;
  rally.createdAt = Date.now(); // reset TTL timer
  rally.phase = 'rallying';
  log.info(`${TAG} Rally reset for fight #${rally.fightCount + 1}`);
  return true;
}

export function getFightCount() {
  if (!rally) return 0;
  return rally.fightCount || 0;
}

export function cancelRally(reason) {
  if (!rally) return;
  log.info(`${TAG} Rally cancelled: ${reason || 'no reason'}`);
  for (const name of [rally.leaderName, ...rally.participants]) {
    const ctx = contexts.get(name);
    if (ctx && typeof ctx.clearRoutineKeepCodes === 'function') {
      ctx.clearRoutineKeepCodes();
    }
  }
  rally = null;
}

// --- Test helpers ---
export function _resetForTests() {
  rally = null;
  evaluating = null;
  contexts.clear();
  enabledBossesMap.clear();
}
