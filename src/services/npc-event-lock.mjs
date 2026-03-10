/**
 * NPC Event Lock — ensures only one character handles NPC trade events at a time.
 *
 * Since maxTotal budgets and gold are account-wide, concurrent NPC purchases
 * across characters would race on the same resources. A simple module-level
 * lock (all characters share one Node.js process) serializes NPC event work.
 *
 * The lock has a lease TTL (default 5 min) as a safety net — if the holding
 * character crashes or gets stuck, the lock auto-releases.
 */

const LEASE_TTL_MS = 5 * 60_000; // 5 minutes

/** @type {{ charName: string, npcCode: string, eventCode: string, acquiredAt: number } | null} */
let holder = null;

function cleanup() {
  if (holder && (Date.now() - holder.acquiredAt) > LEASE_TTL_MS) {
    holder = null;
  }
}

/**
 * Try to acquire the NPC event lock.
 * Re-entrant: returns true if the same character already holds it.
 */
export function acquire(charName, npcCode, eventCode) {
  cleanup();
  if (holder && holder.charName !== charName) return false;
  if (holder && holder.charName === charName) return true;
  holder = { charName, npcCode, eventCode, acquiredAt: Date.now() };
  return true;
}

/**
 * Release the lock if held by the given character.
 */
export function release(charName) {
  if (holder?.charName === charName) holder = null;
}

/**
 * Check if the lock is currently held by a specific character.
 */
export function isHeldBy(charName) {
  cleanup();
  return holder?.charName === charName;
}

/**
 * Check if the lock is held by anyone.
 */
export function isHeld() {
  cleanup();
  return holder !== null;
}

/**
 * Get a copy of the current holder info, or null.
 */
export function getHolder() {
  cleanup();
  return holder ? { ...holder } : null;
}

// --- Test helpers ---
export function _resetForTests() {
  holder = null;
}
