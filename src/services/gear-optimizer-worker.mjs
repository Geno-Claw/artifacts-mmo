/**
 * Gear optimizer worker thread — runs combat gear optimization off the main
 * thread so the scheduler loop stays responsive.
 *
 * Communication protocol (parentPort messages):
 *   Main → Worker:
 *     { type: 'init', gameData }           — hydrate static caches
 *     { type: 'charState', name, char, inventory, candidateMonsters }
 *     { type: 'bankState', bankItems, bankRevision }
 *     { type: 'optimize', id, name, monsterCode, opts }     — on-demand request
 *     { type: 'optimizeRole', id, name, monsterCode, role, opts }
 *     { type: 'shutdown' }
 *
 *   Worker → Main:
 *     { type: 'proactive', name, bestTarget, loadouts, level, bankRevision }
 *     { type: 'optimizeResult', id, result }
 *     { type: 'optimizeRoleResult', id, result }
 *     { type: 'ready' }
 *     { type: 'error', message }
 */
import { parentPort } from 'node:worker_threads';

import { _setCachesForTests } from './game-data.mjs';
import * as gameData from './game-data.mjs';
import {
  optimizeForMonster,
  optimizeForRole,
  findBestCombatTarget,
  _setDeps,
} from './gear-optimizer.mjs';
import { isCombatResultViable } from './combat-simulator.mjs';

// --- Per-character state snapshots ---
const charStates = new Map(); // name → { char, inventory, candidateMonsters, level }
let bankItems = new Map();    // code → quantity
let bankRevision = -1;

// --- Proactive cache ---
// name → { level, bankRevision, bestTarget, loadouts: Map<monsterCode, result> }
const proactiveCache = new Map();

// --- SnapshotContext: minimal ctx interface for gear-optimizer ---

class SnapshotContext {
  constructor(name, char, inventory) {
    this.name = name;
    this._char = char;
    this._inventory = inventory || [];
  }

  get() { return this._char; }

  hasItem(code, quantity = 1) {
    const slot = this._inventory.find(s => s.code === code);
    return slot ? slot.quantity >= quantity : false;
  }

  itemCount(code) {
    const slot = this._inventory.find(s => s.code === code);
    return slot ? slot.quantity : 0;
  }

  skillLevel(skill) {
    return this._char[`${skill}_level`] || 0;
  }

  inventoryCount() {
    let total = 0;
    for (const slot of this._inventory) {
      if (slot.code) total += slot.quantity;
    }
    return total;
  }

  inventoryCapacity() {
    return this._char.inventory_max_items || 0;
  }

  inventoryMaxSlots() {
    return this._inventory.length;
  }

  inventoryUsedSlots() {
    return this._inventory.filter(s => s.code && s.quantity > 0).length;
  }

  inventoryEmptySlots() {
    return Math.max(0, this.inventoryMaxSlots() - this.inventoryUsedSlots());
  }

  inventoryFull() {
    if (this.inventoryEmptySlots() <= 0) return true;
    const cap = this.inventoryCapacity();
    if (cap === 0) return false;
    return this.inventoryCount() >= cap;
  }

  settings() {
    return {};
  }
}

function serializeLoadout(loadout) {
  if (!loadout) return null;
  return [...loadout.entries()];
}

function serializeSimResult(simResult) {
  if (!simResult) return null;
  return { ...simResult };
}

function makeBankSnapshot() {
  return new Map(bankItems);
}

function injectBankDeps() {
  const snapshot = makeBankSnapshot();
  _setDeps({
    getBankItemsFn: async () => snapshot,
    bankCountFn: (code) => snapshot.get(code) || 0,
  });
}

// --- Proactive optimization loop ---

let proactiveRunning = false;
let proactiveAbort = false;

async function yield_() {
  return new Promise(resolve => setImmediate(resolve));
}

async function runProactiveLoop() {
  if (proactiveRunning) return;
  proactiveRunning = true;

  while (!proactiveAbort) {
    let didWork = false;

    for (const [name, state] of charStates) {
      if (proactiveAbort) break;

      const cached = proactiveCache.get(name);
      const stale = !cached
        || cached.level !== state.level
        || cached.bankRevision !== bankRevision;

      if (!stale) continue;
      didWork = true;

      const ctx = new SnapshotContext(name, state.char, state.inventory);
      injectBankDeps();

      const loadouts = new Map();
      let bestTarget = null;

      for (const monster of state.candidateMonsters) {
        if (proactiveAbort) break;
        await yield_();

        try {
          const result = await optimizeForMonster(ctx, monster.code);
          if (!result) continue;

          loadouts.set(monster.code, {
            loadout: serializeLoadout(result.loadout),
            simResult: serializeSimResult(result.simResult),
          });

          if (!isCombatResultViable(result.simResult)) continue;

          const candidate = {
            monsterCode: monster.code,
            monster,
            loadout: serializeLoadout(result.loadout),
            simResult: serializeSimResult(result.simResult),
          };

          if (!bestTarget
            || monster.level > bestTarget.monster.level
            || (monster.level === bestTarget.monster.level
              && (result.simResult.winRate || 0) > (bestTarget.simResult.winRate || 0))) {
            bestTarget = candidate;
          }
        } catch {
          // Skip this monster on error
        }
      }

      if (proactiveAbort) break;

      proactiveCache.set(name, {
        level: state.level,
        bankRevision,
        bestTarget,
        loadouts,
      });

      parentPort.postMessage({
        type: 'proactive',
        name,
        bestTarget,
        loadouts: [...loadouts.entries()],
        level: state.level,
        bankRevision,
      });
    }

    if (!didWork) {
      // Nothing stale — sleep a bit before re-checking
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  proactiveRunning = false;
}

// --- Message handler ---

parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'init': {
        const gd = msg.gameData;
        _setCachesForTests({
          items: gd.items,
          monsters: gd.monsters,
          resources: gd.resources,
          npcBuyOffers: gd.npcBuyOffers.map(([npc, entries]) => [npc, new Map(entries)]),
          npcSellOffers: gd.npcSellOffers.map(([npc, entries]) => [npc, new Map(entries)]),
        });
        parentPort.postMessage({ type: 'ready' });
        // Start proactive loop
        runProactiveLoop();
        break;
      }

      case 'charState': {
        charStates.set(msg.name, {
          char: msg.char,
          inventory: msg.inventory,
          candidateMonsters: msg.candidateMonsters || [],
          level: msg.char?.level || 0,
        });
        break;
      }

      case 'bankState': {
        bankItems = new Map(msg.bankItems);
        bankRevision = msg.bankRevision ?? -1;
        break;
      }

      case 'optimize': {
        const state = charStates.get(msg.name);
        if (!state) {
          parentPort.postMessage({ type: 'optimizeResult', id: msg.id, result: null });
          break;
        }
        const ctx = new SnapshotContext(msg.name, state.char, state.inventory);
        injectBankDeps();
        try {
          const result = await optimizeForMonster(ctx, msg.monsterCode, msg.opts || {});
          parentPort.postMessage({
            type: 'optimizeResult',
            id: msg.id,
            result: result ? {
              loadout: serializeLoadout(result.loadout),
              simResult: serializeSimResult(result.simResult),
            } : null,
          });
        } catch (err) {
          parentPort.postMessage({
            type: 'optimizeResult',
            id: msg.id,
            result: null,
            error: err.message,
          });
        }
        break;
      }

      case 'optimizeRole': {
        const state = charStates.get(msg.name);
        if (!state) {
          parentPort.postMessage({ type: 'optimizeRoleResult', id: msg.id, result: null });
          break;
        }
        const ctx = new SnapshotContext(msg.name, state.char, state.inventory);
        injectBankDeps();
        try {
          const result = await optimizeForRole(ctx, msg.monsterCode, msg.role, msg.opts || {});
          parentPort.postMessage({
            type: 'optimizeRoleResult',
            id: msg.id,
            result: result ? {
              loadout: serializeLoadout(result.loadout),
              simResult: serializeSimResult(result.simResult),
              gearThreat: result.gearThreat,
            } : null,
          });
        } catch (err) {
          parentPort.postMessage({
            type: 'optimizeRoleResult',
            id: msg.id,
            result: null,
            error: err.message,
          });
        }
        break;
      }

      case 'shutdown': {
        proactiveAbort = true;
        process.exit(0);
        break;
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message });
  }
});
