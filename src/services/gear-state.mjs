import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import * as log from '../log.mjs';
import { toPositiveInt } from '../utils.mjs';
import * as gameData from './game-data.mjs';
import { optimizeForMonster } from './gear-optimizer.mjs';
import { createOrMergeOrder } from './order-board.mjs';
import { getBankRevision, globalCount } from './inventory-manager.mjs';
import { getBestToolForSkillAtLevel } from './tool-policy.mjs';
import {
  mapToObject as _mapToObject,
  equipmentCountsOnCharacter as _equipmentCountsOnCharacter,
  isToolItem as _isToolItem,
} from './equipment-utils.mjs';
import {
  computeCharacterRequirements as _computeCharacterRequirements,
  maxMergeCounts as _maxMergeCounts,
} from './gear-requirements.mjs';
import { computeFallbackClaims as _computeFallbackClaims } from './gear-fallback.mjs';

const DEFAULT_GEAR_STATE_PATH = './report/gear-state.json';
const STATE_VERSION = 2;

let initialized = false;
let gearStatePath = process.env.GEAR_STATE_PATH || DEFAULT_GEAR_STATE_PATH;

let characterOrder = [];
let characterConfig = new Map(); // name -> { createOrders, potionEnabled, potionTargetQty }
let contexts = new Map(); // name -> CharacterContext
let stateByChar = new Map(); // name -> state row

let lastBankRevision = -1;
let lastLevelSnapshot = new Map();
let updatedAtMs = 0;

let persistTimer = null;
let persistWritePromise = Promise.resolve();
let persistQueued = false;

function getBestToolForSkillAtLevelSafe(skill, level) {
  try {
    return getBestToolForSkillAtLevel(skill, level);
  } catch {
    return null;
  }
}

let _deps = {
  gameDataSvc: gameData,
  optimizeForMonsterFn: optimizeForMonster,
  getBestToolForSkillAtLevelFn: getBestToolForSkillAtLevelSafe,
  createOrMergeOrderFn: createOrMergeOrder,
  getBankRevisionFn: getBankRevision,
  globalCountFn: globalCount,
};

function nowMs() {
  return Date.now();
}

function mapToObject(map) {
  return _mapToObject(map);
}

function objectToMap(value) {
  const map = new Map();
  if (!value || typeof value !== 'object') return map;

  for (const [code, rawQty] of Object.entries(value)) {
    const qty = toPositiveInt(rawQty);
    if (!code || qty <= 0) continue;
    map.set(code, qty);
  }
  return map;
}

function cloneStateRow(row) {
  const available = row.available || row.owned || new Map();
  const assigned = row.assigned || new Map();
  return {
    available: mapToObject(available),
    assigned: mapToObject(assigned),
    owned: mapToObject(available),
    desired: mapToObject(row.desired || new Map()),
    required: mapToObject(row.required || new Map()),
    selectedMonsters: Array.isArray(row.selectedMonsters) ? [...row.selectedMonsters] : [],
    bestTarget: row.bestTarget || null,
    levelSnapshot: toPositiveInt(row.levelSnapshot),
    bankRevisionSnapshot: toPositiveInt(row.bankRevisionSnapshot),
    updatedAtMs: toPositiveInt(row.updatedAtMs),
  };
}

function normalizeCreateOrders(orderBoard = {}) {
  const enabled = orderBoard?.enabled === true;
  if (typeof orderBoard?.createOrders === 'boolean') return orderBoard.createOrders;
  return enabled;
}

function extractCharacterConfig(charCfg = {}) {
  const skillRoutine = Array.isArray(charCfg.routines)
    ? charCfg.routines.find(r => r?.type === 'skillRotation')
    : null;
  const createOrders = normalizeCreateOrders(skillRoutine?.orderBoard || {});

  const potionSettings = charCfg?.settings?.potions || {};
  const combatPotions = potionSettings?.combat || {};
  const potionEnabled = potionSettings.enabled !== false && combatPotions.enabled !== false;
  const potionTargetQty = potionEnabled ? toPositiveInt(combatPotions.targetQuantity, 0) : 0;

  return {
    createOrders,
    potionEnabled,
    potionTargetQty,
  };
}

function resolveStatePath(opts = {}) {
  const fromOpts = `${opts.path || ''}`.trim();
  if (fromOpts) return fromOpts;

  const fromEnv = `${process.env.GEAR_STATE_PATH || ''}`.trim();
  if (fromEnv) return fromEnv;

  return DEFAULT_GEAR_STATE_PATH;
}

function markUpdated(atMs = nowMs()) {
  updatedAtMs = atMs;
}

function schedulePersist() {
  persistQueued = true;
  if (persistTimer) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;
    queuePersistWrite();
  }, 250);
}

function queuePersistWrite() {
  if (!persistQueued) return persistWritePromise;
  persistQueued = false;

  persistWritePromise = persistWritePromise
    .catch(() => {
      // Previous failure already logged.
    })
    .then(async () => {
      const payload = {
        version: STATE_VERSION,
        updatedAtMs,
        bankRevisionSnapshot: toPositiveInt(lastBankRevision),
        levels: Object.fromEntries([...lastLevelSnapshot.entries()]),
        characters: {},
      };

      for (const name of characterOrder) {
        const row = stateByChar.get(name);
        if (!row) continue;
        payload.characters[name] = cloneStateRow(row);
      }

      const target = gearStatePath || DEFAULT_GEAR_STATE_PATH;
      const dir = dirname(target);
      const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        await rename(tmpPath, target);
      } catch (err) {
        log.warn(`[GearState] Persist failed: ${err?.message || String(err)}`);
        throw err;
      }
    });

  return persistWritePromise;
}

function normalizeLoadedCharacterState(name, raw = {}) {
  const hasAvailableField = Object.prototype.hasOwnProperty.call(raw, 'available');
  const loadedAvailable = hasAvailableField ? objectToMap(raw.available) : objectToMap(raw.owned);
  const row = {
    available: loadedAvailable,
    assigned: objectToMap(raw.assigned),
    desired: objectToMap(raw.desired),
    required: objectToMap(raw.required),
    selectedMonsters: Array.isArray(raw.selectedMonsters)
      ? [...new Set(raw.selectedMonsters.map(v => `${v}`.trim()).filter(Boolean))]
      : [],
    bestTarget: raw.bestTarget ? `${raw.bestTarget}`.trim() : null,
    levelSnapshot: toPositiveInt(raw.levelSnapshot),
    bankRevisionSnapshot: toPositiveInt(raw.bankRevisionSnapshot),
    updatedAtMs: toPositiveInt(raw.updatedAtMs),
  };

  stateByChar.set(name, row);
}

async function loadPersistedState(targetPath, atMs) {
  try {
    const raw = await readFile(targetPath, 'utf-8');
    const payload = JSON.parse(raw);

    const rows = payload?.characters && typeof payload.characters === 'object'
      ? payload.characters
      : {};

    stateByChar = new Map();
    for (const name of characterOrder) {
      normalizeLoadedCharacterState(name, rows[name] || {});
    }

    lastBankRevision = toPositiveInt(payload?.bankRevisionSnapshot, -1);
    lastLevelSnapshot = new Map();
    const levels = payload?.levels && typeof payload.levels === 'object' ? payload.levels : {};
    for (const name of characterOrder) {
      lastLevelSnapshot.set(name, toPositiveInt(levels[name]));
    }

    markUpdated(toPositiveInt(payload?.updatedAtMs, atMs));
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      log.warn(`[GearState] Load failed at ${targetPath}: ${err?.message || String(err)}`);
    }

    stateByChar = new Map();
    for (const name of characterOrder) {
      stateByChar.set(name, {
        available: new Map(),
        assigned: new Map(),
        desired: new Map(),
        required: new Map(),
        selectedMonsters: [],
        bestTarget: null,
        levelSnapshot: 0,
        bankRevisionSnapshot: 0,
        updatedAtMs: atMs,
      });
    }

    lastBankRevision = -1;
    lastLevelSnapshot = new Map();
    for (const name of characterOrder) {
      lastLevelSnapshot.set(name, 0);
    }
    markUpdated(atMs);
  }
}


export function equipmentCountsOnCharacter(ctx) {
  return _equipmentCountsOnCharacter(ctx);
}

function summarizeMap(map, limit = 8) {
  if (!(map instanceof Map) || map.size === 0) return 'none';
  const entries = [...map.entries()]
    .filter(([, qty]) => (Number(qty) || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  const head = entries
    .slice(0, limit)
    .map(([code, qty]) => `${code}x${qty}`)
    .join(', ');
  const rest = entries.length - Math.min(entries.length, limit);
  return rest > 0 ? `${head}, +${rest} more` : head;
}

function summarizeCategoryMap(map) {
  if (!(map instanceof Map) || map.size === 0) return 'none';
  const entries = [...map.entries()]
    .filter(([, qty]) => (Number(qty) || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([category, qty]) => `${category}:${qty}`).join(', ');
}

async function computeCharacterRequirements(name, ctx) {
  const cfg = characterConfig.get(name) || { potionEnabled: false, potionTargetQty: 0 };
  return _computeCharacterRequirements(name, ctx, cfg, {
    gameDataSvc: _deps.gameDataSvc,
    optimizeForMonsterFn: _deps.optimizeForMonsterFn,
    getBestToolForSkillAtLevelFn: _deps.getBestToolForSkillAtLevelFn,
    logFn: (...args) => log.warn(...args),
  });
}

function resolveCraftDesiredOrder(itemCode) {
  const item = _deps.gameDataSvc.getItem(itemCode);
  if (item?.craft?.skill) {
    return {
      sourceCode: itemCode,
      sourceLevel: toPositiveInt(item.craft.level || item.level),
      craftSkill: item.craft.skill,
    };
  }
  return null;
}

export function registerContext(ctx) {
  if (!ctx?.name) return;
  contexts.set(ctx.name, ctx);
}

export function unregisterContext(name) {
  if (!name) return;
  contexts.delete(name);
}

export async function initializeGearState(opts = {}) {
  const chars = Array.isArray(opts.characters) ? opts.characters : [];
  characterOrder = chars.map(c => `${c?.name || ''}`.trim()).filter(Boolean);

  characterConfig = new Map();
  for (const charCfg of chars) {
    const name = `${charCfg?.name || ''}`.trim();
    if (!name) continue;
    characterConfig.set(name, extractCharacterConfig(charCfg));
  }

  gearStatePath = resolveStatePath(opts);
  initialized = true;

  const atMs = nowMs();
  await loadPersistedState(gearStatePath, atMs);

  for (const name of characterOrder) {
    if (!stateByChar.has(name)) {
      stateByChar.set(name, {
        available: new Map(),
        assigned: new Map(),
        desired: new Map(),
        required: new Map(),
        selectedMonsters: [],
        bestTarget: null,
        levelSnapshot: 0,
        bankRevisionSnapshot: toPositiveInt(_deps.getBankRevisionFn()),
        updatedAtMs: atMs,
      });
    }
  }

  markUpdated(atMs);
  schedulePersist();
  return getGearStateSnapshot();
}

function shouldRecompute() {
  if (!initialized) return false;

  const bankRev = toPositiveInt(_deps.getBankRevisionFn(), -1);
  if (bankRev !== lastBankRevision) return true;

  for (const name of characterOrder) {
    const ctx = contexts.get(name);
    if (!ctx) continue;

    let level = 0;
    try {
      level = toPositiveInt(ctx.get().level);
    } catch {
      continue;
    }

    if (level !== toPositiveInt(lastLevelSnapshot.get(name))) {
      return true;
    }
  }

  return false;
}

export async function refreshGearState(opts = {}) {
  if (!initialized) return getGearStateSnapshot();
  if (!opts.force && !shouldRecompute()) return getGearStateSnapshot();

  const previousAvailableByChar = new Map();
  for (const name of characterOrder) {
    const row = stateByChar.get(name);
    const available = row?.available || row?.owned || new Map();
    previousAvailableByChar.set(name, new Map(available));
  }

  const selectedByChar = new Map();
  const requiredByChar = new Map();
  const selectedMonstersByChar = new Map();
  const bestTargetByChar = new Map();
  const levelByChar = new Map();

  for (const name of characterOrder) {
    const ctx = contexts.get(name);
    if (!ctx) continue;

    const result = await computeCharacterRequirements(name, ctx);
    selectedByChar.set(name, result.selected);
    requiredByChar.set(name, result.required);
    selectedMonstersByChar.set(name, result.selectedMonsters);
    bestTargetByChar.set(name, result.bestTarget);
    levelByChar.set(name, result.level);
  }

  const allCodes = new Set();
  for (const req of selectedByChar.values()) {
    for (const code of req.keys()) allCodes.add(code);
  }

  const availability = new Map();
  for (const code of allCodes) {
    availability.set(code, Math.max(0, toPositiveInt(_deps.globalCountFn(code))));
  }

  const atMs = nowMs();
  const bankRevision = toPositiveInt(_deps.getBankRevisionFn(), 0);

  for (const name of characterOrder) {
    const selected = selectedByChar.get(name) || new Map();
    const required = requiredByChar.get(name) || new Map();
    const ctx = contexts.get(name) || null;
    const previousAvailable = previousAvailableByChar.get(name) || new Map();

    const assigned = new Map();
    const desired = new Map();

    for (const [code, qty] of selected.entries()) {
      const need = toPositiveInt(qty);
      if (need <= 0) continue;

      const available = availability.get(code) || 0;
      const assignQty = Math.min(need, available);
      if (assignQty > 0) assigned.set(code, assignQty);

      const missing = need - assignQty;
      if (missing > 0) desired.set(code, missing);

      availability.set(code, Math.max(0, available - assignQty));
    }

    const {
      fallbackClaims,
      missingByCategory,
      addedByCategory,
    } = _computeFallbackClaims(ctx, desired, assigned, previousAvailable, availability, {
      getItemFn: (code) => _deps.gameDataSvc.getItem(code),
      globalCountFn: _deps.globalCountFn,
    });

    const available = new Map(assigned);
    _maxMergeCounts(available, fallbackClaims);

    if (ctx) {
      log.info(
        `[GearState] ${name}: assigned=${summarizeMap(assigned)} desired=${summarizeMap(desired)} ` +
        `fallbackClaims=${summarizeMap(fallbackClaims)} missingByCategory=${summarizeCategoryMap(missingByCategory)} ` +
        `fallbackByCategory=${summarizeCategoryMap(addedByCategory)}`,
      );
    }

    stateByChar.set(name, {
      available,
      assigned,
      desired,
      required,
      selectedMonsters: selectedMonstersByChar.get(name) || [],
      bestTarget: bestTargetByChar.get(name) || null,
      levelSnapshot: toPositiveInt(levelByChar.get(name), 0),
      bankRevisionSnapshot: bankRevision,
      updatedAtMs: atMs,
    });
  }

  lastBankRevision = bankRevision;
  lastLevelSnapshot = new Map();
  for (const name of characterOrder) {
    lastLevelSnapshot.set(name, toPositiveInt(levelByChar.get(name), 0));
  }

  markUpdated(atMs);
  schedulePersist();
  return getGearStateSnapshot();
}

export function getGearStateSnapshot() {
  const characters = {};
  for (const name of characterOrder) {
    const row = stateByChar.get(name);
    if (!row) continue;
    characters[name] = cloneStateRow(row);
  }

  return {
    updatedAtMs: toPositiveInt(updatedAtMs),
    bankRevisionSnapshot: toPositiveInt(lastBankRevision),
    characters,
  };
}

export function getTrackedCharacterNames() {
  return [...characterOrder];
}

export function getCharacterGearState(name) {
  if (!name) return null;
  const row = stateByChar.get(name);
  if (!row) return null;
  return cloneStateRow(row);
}

export function getOwnedMap(name) {
  if (!name) return new Map();
  const row = stateByChar.get(name);
  if (!row) return new Map();
  return new Map(row.available || row.owned || new Map());
}

export function getAvailableMap(name) {
  if (!name) return new Map();
  const row = stateByChar.get(name);
  if (!row) return new Map();
  return new Map(row.available || row.owned || new Map());
}

export function getAssignedMap(name) {
  if (!name) return new Map();
  const row = stateByChar.get(name);
  if (!row) return new Map();
  return new Map(row.assigned || new Map());
}

export function getDesiredMap(name) {
  if (!name) return new Map();
  const row = stateByChar.get(name);
  if (!row) return new Map();
  return new Map(row.desired);
}

export function getOwnedKeepByCodeForInventory(ctx) {
  if (!ctx?.name) return {};
  const owned = getOwnedMap(ctx.name);
  if (owned.size === 0) return {};

  const eqCounts = equipmentCountsOnCharacter(ctx);
  const keepByCode = {};

  for (const [code, qty] of owned.entries()) {
    const keep = Math.max(0, qty - (eqCounts.get(code) || 0));
    if (keep > 0) keepByCode[code] = keep;
  }

  return keepByCode;
}

export function getOwnedDeficitRequests(ctx) {
  if (!ctx?.name) return [];

  const owned = getOwnedMap(ctx.name);
  if (owned.size === 0) return [];

  const eqCounts = equipmentCountsOnCharacter(ctx);
  const requests = [];

  for (const [code, qty] of owned.entries()) {
    const carried = (ctx.itemCount(code) || 0) + (eqCounts.get(code) || 0);
    const missing = Math.max(0, qty - carried);
    if (missing <= 0) continue;
    requests.push({ code, quantity: missing });
  }

  return requests;
}

export function getClaimedTotal(code) {
  if (!code) return 0;
  let total = 0;
  for (const row of stateByChar.values()) {
    total += (row.available || row.owned || new Map()).get(code) || 0;
  }
  return total;
}

export function getClaimedTotalsMap() {
  const totals = new Map();
  for (const row of stateByChar.values()) {
    const available = row.available || row.owned || new Map();
    for (const [code, qty] of available.entries()) {
      totals.set(code, (totals.get(code) || 0) + qty);
    }
  }
  return totals;
}

export function isClaimedByAnyCharacter(code) {
  return getClaimedTotal(code) > 0;
}

export function publishDesiredOrdersForCharacter(name) {
  if (!initialized || !name) return 0;

  const cfg = characterConfig.get(name);
  if (!cfg?.createOrders) return 0;

  const row = stateByChar.get(name);
  if (!row || row.desired.size === 0) return 0;

  let created = 0;

  for (const [itemCode, qty] of row.desired.entries()) {
    const missingQty = toPositiveInt(qty);
    if (missingQty <= 0) continue;
    const item = _deps.gameDataSvc.getItem(itemCode);
    if (_isToolItem(item)) continue;

    const source = resolveCraftDesiredOrder(itemCode);
    if (!source) continue;

    try {
      _deps.createOrMergeOrderFn({
        requesterName: name,
        recipeCode: `gear_state:${name}:${itemCode}`,
        itemCode,
        sourceType: 'craft',
        sourceCode: source.sourceCode,
        craftSkill: source.craftSkill,
        sourceLevel: source.sourceLevel,
        quantity: missingQty,
      });
      created += 1;
    } catch (err) {
      log.warn(`[GearState] Could not create desired order for ${name} ${itemCode}: ${err?.message || String(err)}`);
    }
  }

  return created;
}

export async function flushGearState() {
  if (!initialized) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await queuePersistWrite();
}

export function _resetGearStateForTests() {
  initialized = false;
  gearStatePath = process.env.GEAR_STATE_PATH || DEFAULT_GEAR_STATE_PATH;

  characterOrder = [];
  characterConfig = new Map();
  contexts = new Map();
  stateByChar = new Map();

  lastBankRevision = -1;
  lastLevelSnapshot = new Map();
  updatedAtMs = 0;

  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistWritePromise = Promise.resolve();
  persistQueued = false;

  _deps = {
    gameDataSvc: gameData,
    optimizeForMonsterFn: optimizeForMonster,
    getBestToolForSkillAtLevelFn: getBestToolForSkillAtLevelSafe,
    createOrMergeOrderFn: createOrMergeOrder,
    getBankRevisionFn: getBankRevision,
    globalCountFn: globalCount,
  };
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  _deps = {
    ..._deps,
    ...input,
  };
}
