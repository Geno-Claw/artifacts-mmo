import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import * as log from '../log.mjs';
import { toPositiveInt } from '../utils.mjs';
import * as gameData from './game-data.mjs';
import { optimizeForMonster } from './gear-optimizer.mjs';
import { createOrMergeOrder } from './order-board.mjs';
import { getBankRevision, globalCount } from './inventory-manager.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';
import { getBestToolForSkillAtLevel } from './tool-policy.mjs';

const DEFAULT_GEAR_STATE_PATH = './report/gear-state.json';
const STATE_VERSION = 2;
const RESERVED_FREE_SLOTS = 10;
const CARRY_SLOT_PRIORITY = ['weapon', 'shield', 'helmet', 'body_armor', 'leg_armor', 'boots', 'bag', 'amulet', 'ring1', 'ring2'];
const OWNED_EQUIPMENT_SLOTS = [...new Set([...EQUIPMENT_SLOTS, 'bag'])];
const UTILITY_SLOTS = ['utility1_slot', 'utility2_slot'];
const TOOL_SKILLS = ['mining', 'woodcutting', 'fishing', 'alchemy'];
const FALLBACK_EQUIPPED_SLOTS = [
  { key: 'weapon_slot', category: 'weapon', quantityKey: null },
  { key: 'shield_slot', category: 'shield', quantityKey: null },
  { key: 'helmet_slot', category: 'helmet', quantityKey: null },
  { key: 'body_armor_slot', category: 'body_armor', quantityKey: null },
  { key: 'leg_armor_slot', category: 'leg_armor', quantityKey: null },
  { key: 'boots_slot', category: 'boots', quantityKey: null },
  { key: 'ring1_slot', category: 'ring', quantityKey: null },
  { key: 'ring2_slot', category: 'ring', quantityKey: null },
  { key: 'amulet_slot', category: 'amulet', quantityKey: null },
  { key: 'bag_slot', category: 'bag', quantityKey: null },
  { key: 'utility1_slot', category: 'utility', quantityKey: 'utility1_slot_quantity' },
  { key: 'utility2_slot', category: 'utility', quantityKey: 'utility2_slot_quantity' },
];

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
  const entries = [...map.entries()].filter(([, qty]) => qty > 0);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
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

function countMapTotal(map) {
  let total = 0;
  for (const qty of map.values()) total += qty;
  return total;
}

function maxMergeCounts(target, source) {
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

function computeToolRequirements(level) {
  const required = new Map();
  const charLevel = toPositiveInt(level);
  if (charLevel <= 0) return required;

  for (const skill of TOOL_SKILLS) {
    const tool = _deps.getBestToolForSkillAtLevelFn(skill, charLevel);
    if (!tool?.code) continue;
    incrementCount(required, tool.code, 1);
  }

  return required;
}

export function equipmentCountsOnCharacter(ctx) {
  const char = ctx.get();
  const counts = new Map();
  for (const slot of OWNED_EQUIPMENT_SLOTS) {
    const code = char[`${slot}_slot`] || null;
    if (!code || code === 'none') continue;
    incrementCount(counts, code, 1);
  }
  for (const slot of UTILITY_SLOTS) {
    const code = char[slot] || null;
    if (!code || code === 'none') continue;
    const qty = Math.max(1, toPositiveInt(char[`${slot}_quantity`], 1));
    incrementCount(counts, code, qty);
  }
  return counts;
}

function carriedCountForCode(ctx, equipmentCounts, code) {
  return (ctx.itemCount(code) || 0) + (equipmentCounts.get(code) || 0);
}

function categoryFromItem(item) {
  const type = `${item?.type || ''}`.trim();
  if (!type) return null;
  if (type === 'weapon') {
    return item?.subtype === 'tool' ? 'tool' : 'weapon';
  }
  if (type === 'shield') return 'shield';
  if (type === 'helmet') return 'helmet';
  if (type === 'body_armor') return 'body_armor';
  if (type === 'leg_armor') return 'leg_armor';
  if (type === 'boots') return 'boots';
  if (type === 'ring') return 'ring';
  if (type === 'amulet') return 'amulet';
  if (type === 'bag') return 'bag';
  if (type === 'utility') return 'utility';
  return null;
}

function fallbackCategoryForCode(ctx, code) {
  if (!ctx || !code) return null;
  const item = _deps.gameDataSvc.getItem(code);
  const byType = categoryFromItem(item);
  if (byType) return byType;

  const char = ctx.get();
  for (const slot of FALLBACK_EQUIPPED_SLOTS) {
    if (`${char[slot.key] || ''}`.trim() !== code) continue;
    return slot.category;
  }
  return null;
}

function isToolItem(item) {
  return item?.type === 'weapon' && item?.subtype === 'tool';
}

function addFallbackCandidate(candidatesByCategory, category, row) {
  if (!category || !row?.code) return;
  if (!candidatesByCategory.has(category)) candidatesByCategory.set(category, []);
  candidatesByCategory.get(category).push(row);
}

function fallbackPriority(row) {
  const equipped = row?.source === 'equipped';
  const tool = row?.isTool === true;
  if (equipped && !tool) return 0;
  if (!equipped && !tool) return 1;
  if (equipped && tool) return 2;
  return 3;
}

function compareFallbackRows(a, b) {
  const aPriority = fallbackPriority(a);
  const bPriority = fallbackPriority(b);
  if (aPriority !== bPriority) return aPriority - bPriority;
  if (a.level !== b.level) return b.level - a.level;
  const byCode = a.code.localeCompare(b.code);
  if (byCode !== 0) return byCode;
  return `${a.sourceTag || ''}`.localeCompare(`${b.sourceTag || ''}`);
}

function computeMissingByCategory(ctx, desired) {
  const missing = new Map();
  for (const [code, qty] of desired.entries()) {
    const need = toPositiveInt(qty);
    if (!code || need <= 0) continue;
    const category = fallbackCategoryForCode(ctx, code);
    if (!category) continue;
    missing.set(category, (missing.get(category) || 0) + need);
  }
  return missing;
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

function computeFallbackClaims(ctx, desired, assigned, previousAvailable = new Map(), sharedAvailability = null) {
  if (!ctx) {
    return {
      fallbackClaims: new Map(),
      missingByCategory: new Map(),
      addedByCategory: new Map(),
    };
  }

  const missingByCategory = computeMissingByCategory(ctx, desired);
  if (missingByCategory.size === 0) {
    return {
      fallbackClaims: new Map(),
      missingByCategory,
      addedByCategory: new Map(),
    };
  }

  const char = ctx.get();
  const equipmentCounts = equipmentCountsOnCharacter(ctx);
  const candidatesByCategory = new Map();

  // Keep currently-equipped items first so we never discard what the character can wear now.
  for (const slot of FALLBACK_EQUIPPED_SLOTS) {
    const code = `${char[slot.key] || ''}`.trim();
    if (!code || code === 'none') continue;

    const qty = slot.quantityKey
      ? Math.max(1, toPositiveInt(char[slot.quantityKey], 1))
      : 1;
    if (qty <= 0) continue;

    const item = _deps.gameDataSvc.getItem(code);
    const category = categoryFromItem(item) || slot.category;
    if (!category) continue;
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'equipped',
      sourceTag: slot.key,
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  // Inventory fallback: only known wearable/utility types.
  for (const slot of char.inventory || []) {
    const code = `${slot?.code || ''}`.trim();
    const qty = toPositiveInt(slot?.quantity);
    if (!code || qty <= 0) continue;

    const item = _deps.gameDataSvc.getItem(code);
    const category = categoryFromItem(item);
    if (!category) continue; // Unknown inventory items are not fallback candidates.
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'inventory',
      sourceTag: 'inventory',
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  // Preserve previous-cycle claims that still exist account-wide and are no longer carried.
  for (const [code, rawQty] of previousAvailable.entries()) {
    const prevQty = toPositiveInt(rawQty);
    if (!code || prevQty <= 0) continue;

    const item = _deps.gameDataSvc.getItem(code);
    const category = categoryFromItem(item);
    if (!category) continue; // Unknown stale claims are intentionally dropped.
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    const carried = carriedCountForCode(ctx, equipmentCounts, code);
    const remainingClaim = Math.max(0, prevQty - carried);
    if (remainingClaim <= 0) continue;

    const globalQty = Math.max(0, toPositiveInt(_deps.globalCountFn(code), 0));
    const offCharacterQty = Math.max(0, globalQty - carried);
    const qty = Math.min(remainingClaim, offCharacterQty);
    if (qty <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'inventory',
      sourceTag: 'previous_available',
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  const extraByCode = new Map();
  const addedByCategory = new Map();
  const categoryRows = [...missingByCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [category, needQty] of categoryRows) {
    let remaining = needQty;
    const rows = [...(candidatesByCategory.get(category) || [])].sort(compareFallbackRows);

    for (const row of rows) {
      if (remaining <= 0) break;

      const alreadyExtra = extraByCode.get(row.code) || 0;
      let roomForCode;
      if (sharedAvailability) {
        if (!sharedAvailability.has(row.code)) {
          sharedAvailability.set(row.code, Math.max(0, toPositiveInt(_deps.globalCountFn(row.code), 0)));
        }
        roomForCode = Math.max(0, sharedAvailability.get(row.code) - alreadyExtra);
      } else {
        const assignedQty = assigned.get(row.code) || 0;
        const globalQty = Math.max(0, toPositiveInt(_deps.globalCountFn(row.code), 0));
        roomForCode = Math.max(0, globalQty - assignedQty - alreadyExtra);
      }
      if (roomForCode <= 0) continue;

      const takeQty = Math.min(remaining, row.qty, roomForCode);
      if (takeQty <= 0) continue;

      extraByCode.set(row.code, alreadyExtra + takeQty);
      if (sharedAvailability) {
        const cur = sharedAvailability.get(row.code) || 0;
        sharedAvailability.set(row.code, Math.max(0, cur - takeQty));
      }
      remaining -= takeQty;
    }

    const added = needQty - remaining;
    if (added > 0) addedByCategory.set(category, added);
  }

  const fallbackClaims = new Map();
  for (const [code, extraQty] of extraByCode.entries()) {
    const assignedQty = assigned.get(code) || 0;
    const targetQty = assignedQty + extraQty;
    if (targetQty > assignedQty) fallbackClaims.set(code, targetQty);
  }

  return {
    fallbackClaims,
    missingByCategory,
    addedByCategory,
  };
}

async function computeCharacterRequirements(name, ctx) {
  const cfg = characterConfig.get(name) || { potionEnabled: false, potionTargetQty: 0 };
  const char = ctx.get();
  const level = toPositiveInt(char.level);
  const capacity = Math.max(0, toPositiveInt(ctx.inventoryCapacity()));
  const carryBudget = Math.max(0, capacity - RESERVED_FREE_SLOTS);

  const allRecords = [];
  const monsters = _deps.gameDataSvc.findMonstersByLevel(level);
  for (const monster of monsters) {
    const result = await _deps.optimizeForMonsterFn(ctx, monster.code, {
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
  const toolRequired = computeToolRequirements(level);
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
    log.warn(
      `[GearState] ${name}: selected ownership exceeds carry budget ` +
      `(${selectedTotal} > ${carryBudget}) after tool requirements`,
    );
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
    } = computeFallbackClaims(ctx, desired, assigned, previousAvailable, availability);

    const available = new Map(assigned);
    maxMergeCounts(available, fallbackClaims);

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
    const carried = carriedCountForCode(ctx, eqCounts, code);
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
    if (isToolItem(item)) continue;

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
