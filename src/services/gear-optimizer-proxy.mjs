/**
 * Gear optimizer proxy — spawns a persistent Worker thread for combat gear
 * optimization, caches proactive results, and provides the same API surface
 * as gear-optimizer.mjs for combat functions.
 *
 * Non-combat functions (optimizeForGathering, getCandidatesForSlot) are
 * re-exported directly from gear-optimizer.mjs since they are fast enough
 * for the main thread.
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as log from '../log.mjs';
import { serializeForTransfer } from './game-data.mjs';

// Re-export main-thread-only functions unchanged
export {
  optimizeForGathering,
  getCandidatesForSlot,
  _setDepsForTests,
  _resetDepsForTests,
} from './gear-optimizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, 'gear-optimizer-worker.mjs');
const REQUEST_TIMEOUT_MS = 60_000;

let worker = null;
let readyPromise = null;
let readyResolve = null;
let initialized = false;

// --- Result caches (populated by worker proactive messages) ---
// charName → { monsterCode, monster, loadout (Map), simResult, level, bankRevision }
const targetCache = new Map();
// "charName:monsterCode" → { loadout (Map), simResult }
const loadoutCache = new Map();
// charName → { resolve, reject } — for cold-start await
const coldStartWaiters = new Map();
// id → { resolve, reject, timer } — for on-demand requests
const pendingRequests = new Map();

function deserializeLoadout(entries) {
  if (!entries) return null;
  return new Map(entries);
}

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case 'ready': {
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
      break;
    }

    case 'proactive': {
      const { name, bestTarget, loadouts, level, bankRevision: brev } = msg;

      // Update target cache
      if (bestTarget) {
        targetCache.set(name, {
          monsterCode: bestTarget.monsterCode,
          monster: bestTarget.monster,
          location: bestTarget.location || null,
          loadout: deserializeLoadout(bestTarget.loadout),
          simResult: bestTarget.simResult,
          level,
          bankRevision: brev,
        });
      } else {
        targetCache.delete(name);
      }

      // Update loadout cache
      for (const [monsterCode, entry] of loadouts) {
        const key = `${name}:${monsterCode}`;
        loadoutCache.set(key, {
          loadout: deserializeLoadout(entry.loadout),
          simResult: entry.simResult,
        });
      }

      // Resolve cold-start waiter
      const waiter = coldStartWaiters.get(name);
      if (waiter) {
        coldStartWaiters.delete(name);
        waiter.resolve(targetCache.get(name) || null);
      }

      log.debug(`[GearProxy] Proactive results for ${name}: best=${bestTarget?.monsterCode || 'none'}, ${loadouts.length} loadouts`);
      break;
    }

    case 'optimizeResult': {
      const pending = pendingRequests.get(msg.id);
      if (!pending) break;
      pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.result) {
        pending.resolve({
          loadout: deserializeLoadout(msg.result.loadout),
          simResult: msg.result.simResult,
        });
      } else {
        pending.resolve(null);
      }
      break;
    }

    case 'optimizeRoleResult': {
      const pending = pendingRequests.get(msg.id);
      if (!pending) break;
      pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.result) {
        pending.resolve({
          loadout: deserializeLoadout(msg.result.loadout),
          simResult: msg.result.simResult,
          gearThreat: msg.result.gearThreat,
        });
      } else {
        pending.resolve(null);
      }
      break;
    }

    case 'error': {
      log.warn(`[GearProxy] Worker error: ${msg.message}`);
      break;
    }
  }
}

function spawnWorker() {
  readyPromise = new Promise(resolve => { readyResolve = resolve; });

  worker = new Worker(WORKER_PATH);

  worker.on('message', handleWorkerMessage);

  worker.on('error', (err) => {
    log.error(`[GearProxy] Worker error: ${err.message}`);
    handleWorkerCrash();
  });

  worker.on('exit', (code) => {
    if (code !== 0 && initialized) {
      log.warn(`[GearProxy] Worker exited with code ${code}, restarting...`);
      handleWorkerCrash();
    }
  });
}

function handleWorkerCrash() {
  // Reject all pending requests
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  pendingRequests.clear();

  // Reject cold-start waiters
  for (const [, waiter] of coldStartWaiters) {
    waiter.resolve(null);
  }
  coldStartWaiters.clear();

  worker = null;

  if (initialized) {
    // Auto-restart
    try {
      spawnWorker();
      const gameData = serializeForTransfer();
      worker.postMessage({ type: 'init', gameData });
    } catch (err) {
      log.error(`[GearProxy] Failed to restart worker: ${err.message}`);
    }
  }
}

function sendToWorker(msg) {
  if (!worker) return false;
  try {
    worker.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

function requestWithTimeout(msgType, responseType, msg) {
  const id = randomUUID();
  msg.id = id;
  msg.type = msgType;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      log.warn(`[GearProxy] ${msgType} request timed out (${REQUEST_TIMEOUT_MS}ms)`);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, timer });

    if (!sendToWorker(msg)) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// --- Public API ---

export async function initialize() {
  if (initialized) return;
  initialized = true;

  spawnWorker();
  const gameData = serializeForTransfer();
  worker.postMessage({ type: 'init', gameData });
  await readyPromise;
  log.info('[GearProxy] Worker initialized');
}

export async function shutdown() {
  if (!initialized) return;
  initialized = false;

  if (worker) {
    try {
      worker.postMessage({ type: 'shutdown' });
      await new Promise(resolve => {
        const t = setTimeout(() => resolve(), 2000);
        worker.once('exit', () => { clearTimeout(t); resolve(); });
      });
    } catch {
      // Worker may already be gone
    }
    try {
      await worker.terminate();
    } catch {
      // Already terminated
    }
    worker = null;
  }

  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  pendingRequests.clear();

  for (const [, waiter] of coldStartWaiters) {
    waiter.resolve(null);
  }
  coldStartWaiters.clear();

  targetCache.clear();
  loadoutCache.clear();
}

/**
 * Push character state snapshot to the worker for proactive optimization.
 * Call after ctx.refresh() in the scheduler loop.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Array} candidateMonsters — pre-filtered monster list
 */
export function pushCharState(ctx, candidateMonsters = []) {
  if (!worker) return;
  const char = ctx.get();
  sendToWorker({
    type: 'charState',
    name: ctx.name,
    char: { ...char },
    inventory: [...(char.inventory || [])],
    candidateMonsters,
  });
}

/**
 * Push bank state to the worker.
 *
 * @param {Array} bankItemEntries — [...bankItemsMap.entries()]
 * @param {number} rev — bank revision number
 */
export function pushBankState(bankItemEntries, rev) {
  if (!worker) return;
  sendToWorker({
    type: 'bankState',
    bankItems: bankItemEntries,
    bankRevision: rev,
  });
}

/**
 * Get the best combat target for a character (proactive cache).
 * On cold start, waits for the first proactive result.
 * Falls back to main-thread computation if worker is unavailable.
 */
export async function findBestCombatTarget(ctx) {
  const cached = targetCache.get(ctx.name);
  if (cached && cached.level === ctx.get().level) {
    // Augment with location if missing (worker doesn't have async location lookup)
    return cached;
  }

  if (!worker || !initialized) {
    // Fallback: import and run on main thread
    const { findBestCombatTarget: mainThreadFn } = await import('./gear-optimizer.mjs');
    return mainThreadFn(ctx);
  }

  // Cold start: wait for first proactive result
  return new Promise((resolve) => {
    const existing = coldStartWaiters.get(ctx.name);
    if (existing) {
      // Already waiting — chain
      const prev = existing.resolve;
      existing.resolve = (val) => { prev(val); resolve(val); };
      return;
    }
    coldStartWaiters.set(ctx.name, { resolve });

    // Set a timeout so we don't wait forever
    setTimeout(() => {
      const waiter = coldStartWaiters.get(ctx.name);
      if (waiter) {
        coldStartWaiters.delete(ctx.name);
        waiter.resolve(null);
      }
    }, REQUEST_TIMEOUT_MS);
  });
}

/**
 * Optimize gear for a specific monster (on-demand, with cache).
 */
export async function optimizeForMonster(ctx, monsterCode, opts = {}) {
  if (!worker || !initialized) {
    const { optimizeForMonster: mainThreadFn } = await import('./gear-optimizer.mjs');
    return mainThreadFn(ctx, monsterCode, opts);
  }

  // Serialize excludeBank if present
  const serializedOpts = { ...opts };
  if (opts.excludeBank instanceof Map) {
    serializedOpts.excludeBank = [...opts.excludeBank.entries()];
  }

  return requestWithTimeout('optimize', 'optimizeResult', {
    name: ctx.name,
    monsterCode,
    opts: serializedOpts,
  });
}

/**
 * Optimize gear for a specific role (tank/dps) against a monster.
 */
export async function optimizeForRole(ctx, monsterCode, role, opts = {}) {
  if (!worker || !initialized) {
    const { optimizeForRole: mainThreadFn } = await import('./gear-optimizer.mjs');
    return mainThreadFn(ctx, monsterCode, role, opts);
  }

  const serializedOpts = { ...opts };
  if (opts.excludeBank instanceof Map) {
    serializedOpts.excludeBank = [...opts.excludeBank.entries()];
  }

  return requestWithTimeout('optimizeRole', 'optimizeRoleResult', {
    name: ctx.name,
    monsterCode,
    role,
    opts: serializedOpts,
  });
}
