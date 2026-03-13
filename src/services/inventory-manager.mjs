/**
 * Inventory manager service.
 * Tracks item ownership across bank + all character inventories + equipment.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';

const BANK_CACHE_TTL = 60_000; // 1 minute
const DEFAULT_RESERVATION_TTL = 30_000;
const TOOL_SKILLS = Object.freeze(['mining', 'woodcutting', 'fishing', 'alchemy']);
const inventoryLog = log.createLogger({ scope: 'service.inventory-manager' });

function loggerFor(charName = '') {
  const name = `${charName || ''}`.trim();
  return name ? log.forCharacter(inventoryLog, name) : inventoryLog;
}

let _api = api;

let bank = new Map();             // code -> quantity
let charInventory = new Map();    // charName -> Map<code, quantity>
let charEquipment = new Map();    // charName -> Map<code, quantity>
let charLevels = new Map();       // charName -> level
let charToolProfiles = new Map(); // charName -> { level, mining_level, woodcutting_level, fishing_level, alchemy_level }
let reservations = new Map();     // reservationId -> { code, qty, charName, expiresAt }
let reservationSeq = 0;

let lastBankFetch = 0;
let bankInvalidated = true;
let bankFetchPromise = null;
let bankRevision = 0;

let bankGold = 0;
let bankSlots = 0;
let bankNextExpansionCost = 0;

function toItemMap(slots = []) {
  const map = new Map();
  for (const slot of slots) {
    if (!slot?.code || !slot.quantity || slot.quantity <= 0) continue;
    map.set(slot.code, (map.get(slot.code) || 0) + slot.quantity);
  }
  return map;
}

function toEquipmentMap(charData = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(charData)) {
    if (!key.endsWith('_slot')) continue;
    if (typeof value !== 'string' || value.length === 0 || value === 'none') continue;
    map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function cloneToolProfile(profile = {}) {
  const level = Number(profile?.level);
  const out = {
    level: Number.isFinite(level) && level > 0 ? Math.floor(level) : 0,
  };
  for (const skill of TOOL_SKILLS) {
    const raw = Number(profile?.[`${skill}_level`]);
    out[`${skill}_level`] = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  }
  return out;
}

function buildToolProfile(charData = {}) {
  const profile = {
    level: Number(charData?.level),
  };
  for (const skill of TOOL_SKILLS) {
    profile[`${skill}_level`] = Number(charData?.[`${skill}_level`]);
  }
  return cloneToolProfile(profile);
}

function toolProfileMapToObject(map) {
  const out = {};
  for (const [name, profile] of map.entries()) {
    out[name] = cloneToolProfile(profile);
  }
  return out;
}

function nestedMapToObject(nested) {
  const out = {};
  for (const [name, map] of nested.entries()) {
    out[name] = mapToObject(map);
  }
  return out;
}

function nextReservationId() {
  reservationSeq += 1;
  return `res_${Date.now()}_${reservationSeq}`;
}

function reservationExpiry(ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return Date.now() + DEFAULT_RESERVATION_TTL;
  return Date.now() + ttl;
}

function sumReserved(code, { includeChar = null } = {}) {
  let total = 0;
  for (const res of reservations.values()) {
    if (res.code !== code) continue;
    if (includeChar && res.charName === includeChar) continue;
    total += res.qty;
  }
  return total;
}

export async function initialize() {
  const chars = await _api.getMyCharacters();
  const list = Array.isArray(chars) ? chars : [];

  for (const char of list) {
    if (!char?.name) continue;
    updateCharacter(char.name, char);
  }

  await getBankItems(true);
  await _refreshBankDetails();
  inventoryLog.info(`[InventoryManager] Initialized: ${list.length} character(s), ${bank.size} bank item(s), ${bankGold}g`, {
    event: 'inventory.initialized',
    data: {
      characters: list.length,
      bankItems: bank.size,
      bankGold,
    },
  });
}

export function updateCharacter(name, charData) {
  if (!name || !charData) return;
  charInventory.set(name, toItemMap(charData.inventory || []));
  charEquipment.set(name, toEquipmentMap(charData));
  const level = Number(charData.level);
  if (Number.isFinite(level) && level > 0) {
    charLevels.set(name, Math.floor(level));
  } else {
    charLevels.delete(name);
  }
  charToolProfiles.set(name, buildToolProfile(charData));
}

export function invalidateBank(reason = '') {
  bankInvalidated = true;
  if (reason) {
    inventoryLog.debug(`[InventoryManager] Bank invalidated: ${reason}`, {
      event: 'inventory.bank.invalidated',
      data: { reason },
    });
  }
}

export function cleanupExpiredReservations() {
  const now = Date.now();
  let removed = 0;
  for (const [id, res] of reservations.entries()) {
    if (res.expiresAt > now) continue;
    reservations.delete(id);
    removed++;
  }
  return removed;
}

export async function getBankItems(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && !bankInvalidated && lastBankFetch > 0 && (now - lastBankFetch) < BANK_CACHE_TTL) {
    return bank;
  }

  if (bankFetchPromise) return bankFetchPromise;

  bankFetchPromise = _fetchBankItems();
  try {
    return await bankFetchPromise;
  } finally {
    bankFetchPromise = null;
  }
}

async function _fetchBankItems() {
  const newMap = new Map();
  let page = 1;

  while (true) {
    const result = await _api.getBankItems({ page, size: 100 });
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) break;

    for (const item of items) {
      if (!item?.code) continue;
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) continue;
      // Last-write-wins for duplicate codes across shifting pagination.
      newMap.set(item.code, qty);
    }

    if (items.length < 100) break;
    page++;
  }

  bank = newMap;
  lastBankFetch = Date.now();
  bankInvalidated = false;
  bankRevision += 1;
  inventoryLog.debug(`[InventoryManager] Bank refreshed: ${bank.size} unique items`, {
    event: 'inventory.bank.refreshed',
    data: {
      bankItems: bank.size,
      bankRevision,
    },
  });
  return bank;
}

async function _refreshBankDetails() {
  try {
    const details = await _api.getBankDetails();
    if (details && typeof details === 'object') {
      const gold = Number(details.gold);
      const slots = Number(details.slots);
      const cost = Number(details.next_expansion_cost);
      if (Number.isFinite(gold)) bankGold = gold;
      if (Number.isFinite(slots)) bankSlots = slots;
      if (Number.isFinite(cost)) bankNextExpansionCost = cost;
    }
  } catch (err) {
    inventoryLog.warn(`[InventoryManager] Failed to refresh bank details: ${err?.message || err}`, {
      event: 'inventory.bank.details_failed',
      reasonCode: 'request_failed',
      error: err instanceof Error ? err : new Error(`${err}`),
    });
  }
}

export function applyBankDelta(items, op, meta = {}) {
  const list = Array.isArray(items) ? items : [];
  if (op !== 'deposit' && op !== 'withdraw') {
    throw new Error(`Invalid bank delta op: "${op}"`);
  }

  for (const entry of list) {
    const code = entry?.code;
    const qty = Number(entry?.quantity) || 0;
    if (!code || qty <= 0) continue;

    const current = bank.get(code) || 0;
    if (op === 'deposit') {
      bank.set(code, current + qty);
      continue;
    }

    // withdraw
    const next = current - qty;
    if (next > 0) {
      bank.set(code, next);
    } else {
      if (current > 0 && qty > current) {
        inventoryLog.warn(`[InventoryManager] Bank delta clamped for ${code}: tried -${qty}, had ${current}`, {
          event: 'inventory.bank.delta_clamped',
          reasonCode: 'routine_conditions_changed',
          data: {
            code,
            quantity: qty,
            current,
            op,
          },
        });
      }
      bank.delete(code);
    }
  }

  lastBankFetch = Date.now();
  bankInvalidated = false;
  bankRevision += 1;

  if (meta?.reason) {
    const by = meta?.charName ? ` by ${meta.charName}` : '';
    loggerFor(meta?.charName).debug(`[InventoryManager] Applied bank ${op} delta${by}: ${meta.reason}`, {
      event: op === 'deposit' ? 'inventory.bank.deposit_delta' : 'inventory.bank.withdraw_delta',
      data: {
        op,
        charName: meta?.charName || null,
        reason: meta.reason,
        bankRevision,
        items: list.map(entry => ({
          code: entry?.code || null,
          quantity: Number(entry?.quantity) || 0,
        })),
      },
    });
  }
}

export function applyBankGoldDelta(quantity, op) {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return;
  if (op === 'deposit') bankGold += qty;
  else if (op === 'withdraw') bankGold = Math.max(0, bankGold - qty);
}

export function bankCount(code) {
  return bank.get(code) || 0;
}

export function getBankRevision() {
  return bankRevision;
}

export function getBankSummary({ includeItems = false } = {}) {
  const summary = {
    gold: bankGold,
    slots: bankSlots,
    usedSlots: bank.size,
    nextExpansionCost: bankNextExpansionCost,
  };
  if (includeItems) {
    summary.items = [...bank.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, quantity]) => ({ code, quantity }));
  }
  return summary;
}

export function availableBankCount(code, opts = {}) {
  cleanupExpiredReservations();
  const includeChar = opts.includeChar || null;
  const available = bankCount(code) - sumReserved(code, { includeChar });
  return Math.max(available, 0);
}

export function inventoryCount(code, opts = {}) {
  const excludeChar = opts.excludeChar || null;
  let total = 0;
  for (const [name, inv] of charInventory.entries()) {
    if (excludeChar && name === excludeChar) continue;
    total += inv.get(code) || 0;
  }
  return total;
}

export function equippedCount(code, opts = {}) {
  const excludeChar = opts.excludeChar || null;
  let total = 0;
  for (const [name, eq] of charEquipment.entries()) {
    if (excludeChar && name === excludeChar) continue;
    total += eq.get(code) || 0;
  }
  return total;
}

export function globalCount(code) {
  return bankCount(code) + inventoryCount(code) + equippedCount(code);
}

export function nonEquippedCount(code) {
  return bankCount(code) + inventoryCount(code);
}

export function getCharacterLevelsSnapshot() {
  const out = {};
  for (const [name, level] of charLevels.entries()) {
    out[name] = level;
  }
  return out;
}

export function getCharacterToolProfilesSnapshot() {
  return toolProfileMapToObject(charToolProfiles);
}

export function charHasEquipped(name, code) {
  return (charEquipment.get(name)?.get(code) || 0) > 0;
}

export function reserve(code, qty, charName, ttlMs = DEFAULT_RESERVATION_TTL) {
  cleanupExpiredReservations();
  const requested = Number(qty) || 0;
  if (!code || requested <= 0 || !charName) return null;

  const available = availableBankCount(code, { includeChar: charName });
  if (available < requested) return null;

  const id = nextReservationId();
  reservations.set(id, {
    code,
    qty: requested,
    charName,
    expiresAt: reservationExpiry(ttlMs),
  });
  return id;
}

export function reserveMany(requests, charName, ttlMs = DEFAULT_RESERVATION_TTL) {
  cleanupExpiredReservations();
  if (!Array.isArray(requests) || requests.length === 0) {
    return { ok: true, reservations: [], reason: '' };
  }
  if (!charName) {
    return { ok: false, reservations: [], reason: 'missing charName' };
  }

  // Aggregate duplicate codes so the check is atomic per code.
  const aggregated = new Map();
  for (const req of requests) {
    const code = req?.code;
    const qty = Number(req?.qty ?? req?.quantity) || 0;
    if (!code || qty <= 0) continue;
    aggregated.set(code, (aggregated.get(code) || 0) + qty);
  }

  for (const [code, qty] of aggregated.entries()) {
    const available = availableBankCount(code, { includeChar: charName });
    if (available < qty) {
      return {
        ok: false,
        reservations: [],
        reason: `insufficient ${code}: need ${qty}, available ${available}`,
      };
    }
  }

  const created = [];
  for (const [code, qty] of aggregated.entries()) {
    const id = nextReservationId();
    reservations.set(id, {
      code,
      qty,
      charName,
      expiresAt: reservationExpiry(ttlMs),
    });
    created.push({ id, code, qty, charName });
  }

  return { ok: true, reservations: created, reason: '' };
}

export function release(reservationId) {
  if (!reservationId) return;
  reservations.delete(reservationId);
}

export function releaseAllForChar(charName) {
  if (!charName) return;
  for (const [id, res] of reservations.entries()) {
    if (res.charName === charName) reservations.delete(id);
  }
}

export function snapshot() {
  cleanupExpiredReservations();
  const reservationRows = {};
  for (const [id, res] of reservations.entries()) {
    reservationRows[id] = { ...res };
  }

  return {
    bank: mapToObject(bank),
    bankRevision,
    charInventory: nestedMapToObject(charInventory),
    charEquipment: nestedMapToObject(charEquipment),
    charLevels: mapToObject(charLevels),
    charToolProfiles: toolProfileMapToObject(charToolProfiles),
    reservations: reservationRows,
  };
}

// Test helpers.
export function _setApiClientForTests(client) {
  _api = client || api;
}

export function _resetForTests() {
  bank = new Map();
  charInventory = new Map();
  charEquipment = new Map();
  charLevels = new Map();
  charToolProfiles = new Map();
  reservations = new Map();
  reservationSeq = 0;
  lastBankFetch = 0;
  bankInvalidated = true;
  bankFetchPromise = null;
  bankRevision = 0;
  bankGold = 0;
  bankSlots = 0;
  bankNextExpansionCost = 0;
  _api = api;
}
