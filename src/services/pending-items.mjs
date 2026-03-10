import * as api from '../api.mjs';
import * as log from '../log.mjs';

const pendingLog = log.createLogger({ scope: 'service.pending-items' });

const CACHE_TTL_MS = 60_000;

let _api = api;
let pendingItems = [];
let lastFetch = 0;
let cacheInvalidated = true;
let refreshPromise = null;
let claimLock = null;

function parseCreatedAtMs(entry) {
  const ms = Date.parse(`${entry?.created_at || ''}`);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizePendingItems(items = []) {
  return [...items]
    .filter(item => item && typeof item === 'object' && !item.claimed_at)
    .sort((a, b) => {
      const createdDelta = parseCreatedAtMs(a) - parseCreatedAtMs(b);
      if (createdDelta !== 0) return createdDelta;
      return `${a?.id || ''}`.localeCompare(`${b?.id || ''}`);
    });
}

function extractPageRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

function cacheIsStale(now = Date.now()) {
  return cacheInvalidated || lastFetch <= 0 || (now - lastFetch) >= CACHE_TTL_MS;
}

async function loadAllPendingItems() {
  const all = [];
  let page = 1;

  while (true) {
    const result = await _api.getPendingItems({ page, size: 100 });
    const rows = extractPageRows(result);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 100) break;
    page += 1;
  }

  return normalizePendingItems(all);
}

export function invalidatePendingItems(reason = '') {
  cacheInvalidated = true;
  if (reason) {
    pendingLog.debug(`Pending items invalidated: ${reason}`, {
      event: 'pending_items.invalidated',
      data: { reason },
    });
  }
}

export async function refreshPendingItems(forceRefresh = false) {
  if (!forceRefresh && !cacheIsStale()) {
    return pendingItems;
  }
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const items = await loadAllPendingItems();
    pendingItems = items;
    lastFetch = Date.now();
    cacheInvalidated = false;
    pendingLog.debug(`Pending items refreshed: ${items.length} claimable`, {
      event: 'pending_items.refreshed',
      data: {
        count: items.length,
        forceRefresh: forceRefresh === true,
      },
    });
    return items;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export function getPendingItemsSnapshot() {
  return pendingItems.map(item => ({
    ...item,
    items: Array.isArray(item?.items) ? item.items.map(row => ({ ...row })) : [],
  }));
}

export function removePendingItemById(id) {
  const targetId = `${id || ''}`.trim();
  if (!targetId) return;
  pendingItems = pendingItems.filter(item => `${item?.id || ''}` !== targetId);
}

export function hasClaimableItems({ allowBackgroundRefresh = true } = {}) {
  if (allowBackgroundRefresh !== false && cacheIsStale() && !refreshPromise) {
    refreshPendingItems(false).catch((err) => {
      pendingLog.warn(`Pending items refresh failed: ${err?.message || String(err)}`, {
        event: 'pending_items.refresh_failed',
        reasonCode: 'request_failed',
        error: err,
      });
    });
  }
  return pendingItems.length > 0;
}

export async function withClaimLock(ctxOrName, fn) {
  const charName = `${ctxOrName?.name || ctxOrName || ''}`.trim() || 'unknown';

  if (claimLock) {
    pendingLog.info(`[${charName}] Pending items: waiting for claim lock`, {
      event: 'pending_items.lock_wait',
      reasonCode: 'yield_for_backoff',
      context: {
        character: charName,
      },
    });
  }

  while (claimLock) await claimLock;

  let release;
  claimLock = new Promise(resolve => {
    release = resolve;
  });

  try {
    return await fn();
  } finally {
    claimLock = null;
    release();
  }
}

export async function claimPendingItemForCharacter(id, name) {
  return _api.claimPendingItem(id, name);
}

export function _setApiClientForTests(client) {
  _api = client || api;
}

export function _resetForTests() {
  _api = api;
  pendingItems = [];
  lastFetch = 0;
  cacheInvalidated = true;
  refreshPromise = null;
  claimLock = null;
}
