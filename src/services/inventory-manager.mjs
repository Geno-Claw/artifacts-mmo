/**
 * Inventory manager service.
 * Tracks item ownership across bank + all character inventories + equipment.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';

const BANK_CACHE_TTL = 60_000; // 1 minute

let _api = api;

let bank = new Map();             // code -> quantity
let charInventory = new Map();    // charName -> Map<code, quantity>
let charEquipment = new Map();    // charName -> Map<code, quantity>

let lastBankFetch = 0;
let bankInvalidated = true;
let bankFetchPromise = null;

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

function nestedMapToObject(nested) {
  const out = {};
  for (const [name, map] of nested.entries()) {
    out[name] = mapToObject(map);
  }
  return out;
}

export async function initialize() {
  const chars = await _api.getMyCharacters();
  const list = Array.isArray(chars) ? chars : [];

  for (const char of list) {
    if (!char?.name) continue;
    updateCharacter(char.name, char);
  }

  await getBankItems(true);
  log.info(`[InventoryManager] Initialized: ${list.length} character(s), ${bank.size} bank item(s)`);
}

export function updateCharacter(name, charData) {
  if (!name || !charData) return;
  charInventory.set(name, toItemMap(charData.inventory || []));
  charEquipment.set(name, toEquipmentMap(charData));
}

export function invalidateBank(reason = '') {
  bankInvalidated = true;
  if (reason) log.info(`[InventoryManager] Bank invalidated: ${reason}`);
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
  log.info(`[InventoryManager] Bank refreshed: ${bank.size} unique items`);
  return bank;
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
        log.warn(`[InventoryManager] Bank delta clamped for ${code}: tried -${qty}, had ${current}`);
      }
      bank.delete(code);
    }
  }

  lastBankFetch = Date.now();
  bankInvalidated = false;

  if (meta?.reason) {
    const by = meta?.charName ? ` by ${meta.charName}` : '';
    log.info(`[InventoryManager] Applied bank ${op} delta${by}: ${meta.reason}`);
  }
}

export function bankCount(code) {
  return bank.get(code) || 0;
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

export function charHasEquipped(name, code) {
  return (charEquipment.get(name)?.get(code) || 0) > 0;
}

export function snapshot() {
  return {
    bank: mapToObject(bank),
    charInventory: nestedMapToObject(charInventory),
    charEquipment: nestedMapToObject(charEquipment),
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
  lastBankFetch = 0;
  bankInvalidated = true;
  bankFetchPromise = null;
  _api = api;
}
