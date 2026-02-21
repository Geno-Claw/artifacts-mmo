const ACCOUNT_DETAILS_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_ACHIEVEMENTS_TTL_MS = 10 * 60 * 1000;
const ACHIEVEMENT_DEFINITIONS_TTL_MS = 30 * 60 * 1000;

let nowImpl = () => Date.now();
let apiModulePromise = null;
let detailsCache = null;
let definitionsCache = null;
const achievementsCache = new Map();

function nowMs() {
  return nowImpl();
}

function isFresh(entry, atMs) {
  return Boolean(entry && !entry.promise && entry.expiresAtMs > atMs);
}

function toResult(entry, fromCache) {
  return {
    data: entry.data,
    fetchedAtMs: entry.fetchedAtMs,
    expiresAtMs: entry.expiresAtMs,
    fromCache,
  };
}

function normalizeAccount(account) {
  const safe = `${account || ''}`.trim();
  if (!safe) {
    const err = new Error('Account is required');
    err.code = 'account_required';
    throw err;
  }
  return safe;
}

function normalizeParams(params = {}) {
  const entries = [];
  if (!params || typeof params !== 'object') return entries;

  for (const [key, rawValue] of Object.entries(params)) {
    if (rawValue == null) continue;

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item == null) continue;
        entries.push([`${key}`, `${item}`]);
      }
      continue;
    }

    entries.push([`${key}`, `${rawValue}`]);
  }

  entries.sort((a, b) => {
    if (a[0] === b[0]) return a[1].localeCompare(b[1]);
    return a[0].localeCompare(b[0]);
  });

  return entries;
}

function achievementsCacheKey(account, params) {
  const safeAccount = normalizeAccount(account);
  const qs = new URLSearchParams(normalizeParams(params)).toString();
  return `${safeAccount}::${qs}`;
}

async function getApiModule() {
  if (!apiModulePromise) {
    apiModulePromise = import('../api.mjs');
  }
  return apiModulePromise;
}

async function refreshDetails() {
  const { getMyDetails } = await getApiModule();
  const data = await getMyDetails();
  const fetchedAtMs = nowMs();
  const next = {
    data,
    fetchedAtMs,
    expiresAtMs: fetchedAtMs + ACCOUNT_DETAILS_TTL_MS,
  };
  detailsCache = next;
  return toResult(next, false);
}

async function refreshDefinitions() {
  const { getAchievements } = await getApiModule();
  const allItems = [];
  let page = 1;
  const size = 100;
  for (;;) {
    const raw = await getAchievements({ page, size });
    const payload = raw && typeof raw === 'object' ? raw : {};
    const list = Array.isArray(payload.data) ? payload.data : (Array.isArray(raw) ? raw : []);
    allItems.push(...list);
    const totalPages = payload.pages ?? 1;
    if (page >= totalPages || list.length < size) break;
    page++;
  }
  const fetchedAtMs = nowMs();
  const next = {
    data: allItems,
    fetchedAtMs,
    expiresAtMs: fetchedAtMs + ACHIEVEMENT_DEFINITIONS_TTL_MS,
  };
  definitionsCache = next;
  return toResult(next, false);
}

async function refreshAchievements(cacheKey, account, params = {}) {
  const { getAccountAchievements } = await getApiModule();
  const data = await getAccountAchievements(account, params);
  const fetchedAtMs = nowMs();
  const next = {
    data,
    fetchedAtMs,
    expiresAtMs: fetchedAtMs + ACCOUNT_ACHIEVEMENTS_TTL_MS,
  };
  achievementsCache.set(cacheKey, next);
  return toResult(next, false);
}

export async function getCachedAccountDetails({ forceRefresh = false } = {}) {
  const atMs = nowMs();
  if (!forceRefresh && isFresh(detailsCache, atMs)) {
    return toResult(detailsCache, true);
  }

  if (detailsCache?.promise) {
    return detailsCache.promise;
  }

  const previous = detailsCache && !detailsCache.promise ? detailsCache : null;
  const promise = refreshDetails();
  detailsCache = { ...previous, promise };

  try {
    return await promise;
  } catch (err) {
    detailsCache = previous;
    throw err;
  }
}

export async function getCachedAccountAchievements(account, params = {}, { forceRefresh = false } = {}) {
  const safeAccount = normalizeAccount(account);
  const cacheKey = achievementsCacheKey(safeAccount, params);
  const cacheEntry = achievementsCache.get(cacheKey) || null;
  const atMs = nowMs();

  if (!forceRefresh && isFresh(cacheEntry, atMs)) {
    return toResult(cacheEntry, true);
  }

  if (cacheEntry?.promise) {
    return cacheEntry.promise;
  }

  const previous = cacheEntry && !cacheEntry.promise ? cacheEntry : null;
  const promise = refreshAchievements(cacheKey, safeAccount, params);
  achievementsCache.set(cacheKey, { ...previous, promise });

  try {
    return await promise;
  } catch (err) {
    if (previous) achievementsCache.set(cacheKey, previous);
    else achievementsCache.delete(cacheKey);
    throw err;
  }
}

export async function getCachedAchievementDefinitions({ forceRefresh = false } = {}) {
  const atMs = nowMs();
  if (!forceRefresh && isFresh(definitionsCache, atMs)) {
    return toResult(definitionsCache, true);
  }

  if (definitionsCache?.promise) {
    return definitionsCache.promise;
  }

  const previous = definitionsCache && !definitionsCache.promise ? definitionsCache : null;
  const promise = refreshDefinitions();
  definitionsCache = { ...previous, promise };

  try {
    return await promise;
  } catch (err) {
    definitionsCache = previous;
    throw err;
  }
}

export function _resetAccountCacheForTests() {
  nowImpl = () => Date.now();
  apiModulePromise = null;
  detailsCache = null;
  definitionsCache = null;
  achievementsCache.clear();
}

export function _setAccountCacheNowForTests(nowFn) {
  nowImpl = typeof nowFn === 'function' ? nowFn : (() => Date.now());
}

export {
  ACCOUNT_DETAILS_TTL_MS,
  ACCOUNT_ACHIEVEMENTS_TTL_MS,
  ACHIEVEMENT_DEFINITIONS_TTL_MS,
};
