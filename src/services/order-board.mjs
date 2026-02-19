import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as log from '../log.mjs';

const DEFAULT_BOARD_PATH = './report/order-board.json';
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BLOCKED_RETRY_MS = 600_000;
const MIN_DURATION_MS = 1_000;

let boardPath = process.env.ORDER_BOARD_PATH || DEFAULT_BOARD_PATH;
let initialized = false;
let orders = new Map();
let updatedAtMs = 0;
let subscribers = new Set();

let persistTimer = null;
let persistWritePromise = Promise.resolve();
let persistQueued = false;

function nowMs() {
  return Date.now();
}

function toPositiveInt(value, fallback, min = MIN_DURATION_MS) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(min, Math.floor(num));
}

function mergeKeyFor(sourceType, sourceCode, itemCode) {
  return `${sourceType}:${sourceCode}:${itemCode}`;
}

function normalizeSourceType(value) {
  if (value === 'fight') return 'fight';
  if (value === 'gather') return 'gather';
  if (value === 'craft') return 'craft';
  return '';
}

function ensureStatus(order, atMs) {
  if (!order) return;

  pruneExpiredBlocks(order, atMs);

  if (order.claim && order.claim.expiresAtMs <= atMs) {
    order.claim = null;
  }

  if (order.remainingQty <= 0) {
    order.remainingQty = 0;
    order.status = 'fulfilled';
    if (!order.fulfilledAtMs) order.fulfilledAtMs = atMs;
    order.claim = null;
    return;
  }

  if (order.claim) {
    order.status = 'claimed';
    return;
  }

  order.status = 'open';
}

function pruneExpiredBlocks(order, atMs) {
  if (!order?.blockedByChar) {
    order.blockedByChar = {};
    return;
  }

  for (const [name, expiresAtMs] of Object.entries(order.blockedByChar)) {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= atMs) {
      delete order.blockedByChar[name];
    }
  }
}

function cloneOrder(order) {
  return JSON.parse(JSON.stringify(order));
}

function getSortedOrders(atMs = nowMs()) {
  const list = [];
  for (const order of orders.values()) {
    ensureStatus(order, atMs);
    list.push(order);
  }
  list.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  return list;
}

function emitChange() {
  for (const cb of subscribers) {
    try {
      cb();
    } catch {
      // Listener failures should not impact board state updates.
    }
  }
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
      // Previous write failure is already logged; continue write queue.
    })
    .then(async () => {
      const payload = {
        version: 1,
        updatedAtMs,
        orders: getSortedOrders(nowMs()).map(cloneOrder),
      };

      const target = boardPath || DEFAULT_BOARD_PATH;
      const dir = dirname(target);
      const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        await rename(tmpPath, target);
      } catch (err) {
        log.warn(`[OrderBoard] Persist failed: ${err?.message || String(err)}`);
        throw err;
      }
    });

  return persistWritePromise;
}

function normalizeContributionKey(requesterName, recipeCode) {
  return `${requesterName || ''}::${recipeCode || ''}`;
}

function normalizeLoadedOrder(raw, atMs) {
  if (!raw || typeof raw !== 'object') return null;

  const itemCode = `${raw.itemCode || ''}`.trim();
  const sourceType = normalizeSourceType(raw.sourceType);
  const sourceCode = `${raw.sourceCode || ''}`.trim();
  if (!itemCode || !sourceType || !sourceCode) return null;

  const id = `${raw.id || randomUUID()}`;
  const requestedQty = Math.max(0, Math.floor(Number(raw.requestedQty) || 0));
  const remainingQty = Math.max(0, Math.floor(Number(raw.remainingQty) || 0));

  const order = {
    id,
    mergeKey: mergeKeyFor(sourceType, sourceCode, itemCode),
    itemCode,
    sourceType,
    sourceCode,
    gatherSkill: sourceType === 'gather' ? `${raw.gatherSkill || ''}`.trim() || null : null,
    craftSkill: sourceType === 'craft' ? `${raw.craftSkill || ''}`.trim() || null : null,
    sourceLevel: Math.max(0, Math.floor(Number(raw.sourceLevel) || 0)),
    requestedQty,
    remainingQty,
    status: 'open',
    requesters: Array.isArray(raw.requesters) ? [...new Set(raw.requesters.map(v => `${v}`.trim()).filter(Boolean))] : [],
    recipes: Array.isArray(raw.recipes) ? [...new Set(raw.recipes.map(v => `${v}`.trim()).filter(Boolean))] : [],
    contributions: raw.contributions && typeof raw.contributions === 'object' ? { ...raw.contributions } : {},
    claim: raw.claim && typeof raw.claim === 'object' ? {
      charName: `${raw.claim.charName || ''}`.trim(),
      claimedAtMs: Math.floor(Number(raw.claim.claimedAtMs) || 0),
      leaseMs: toPositiveInt(raw.claim.leaseMs, DEFAULT_LEASE_MS),
      expiresAtMs: Math.floor(Number(raw.claim.expiresAtMs) || 0),
    } : null,
    blockedByChar: raw.blockedByChar && typeof raw.blockedByChar === 'object' ? { ...raw.blockedByChar } : {},
    createdAtMs: Math.floor(Number(raw.createdAtMs) || atMs),
    updatedAtMs: Math.floor(Number(raw.updatedAtMs) || atMs),
    fulfilledAtMs: raw.fulfilledAtMs ? Math.floor(Number(raw.fulfilledAtMs) || 0) : null,
  };

  if (order.claim && !order.claim.charName) {
    order.claim = null;
  }

  ensureStatus(order, atMs);
  return order;
}

async function loadPersistedBoard(targetPath, atMs) {
  try {
    const raw = await readFile(targetPath, 'utf-8');
    const payload = JSON.parse(raw);

    const rows = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.orders) ? payload.orders : []);

    const loaded = new Map();
    for (const row of rows) {
      const order = normalizeLoadedOrder(row, atMs);
      if (!order) continue;
      loaded.set(order.id, order);
    }

    orders = loaded;
    markUpdated(Number(payload?.updatedAtMs) || atMs);
    return;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      orders = new Map();
      markUpdated(atMs);
      return;
    }

    log.warn(`[OrderBoard] Load failed at ${targetPath}: ${err?.message || String(err)}`);
    orders = new Map();
    markUpdated(atMs);
  }
}

function resolveBoardPath(opts = {}) {
  const fromOpts = `${opts.path || ''}`.trim();
  if (fromOpts) return fromOpts;

  const fromEnv = `${process.env.ORDER_BOARD_PATH || ''}`.trim();
  if (fromEnv) return fromEnv;

  return DEFAULT_BOARD_PATH;
}

function findByMergeKey(mergeKey) {
  for (const order of orders.values()) {
    if (order.mergeKey !== mergeKey) continue;
    ensureStatus(order, nowMs());
    if (order.status === 'fulfilled') continue;
    return order;
  }
  return null;
}

export async function initializeOrderBoard(opts = {}) {
  boardPath = resolveBoardPath(opts);
  initialized = true;

  const atMs = nowMs();
  await loadPersistedBoard(boardPath, atMs);

  for (const order of orders.values()) {
    ensureStatus(order, atMs);
    order.updatedAtMs = atMs;
  }

  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return getOrderBoardSnapshot();
}

export function createOrMergeOrder(request = {}) {
  if (!initialized) return null;

  const sourceType = normalizeSourceType(request.sourceType);
  const sourceCode = `${request.sourceCode || ''}`.trim();
  const itemCode = `${request.itemCode || ''}`.trim();
  const requesterName = `${request.requesterName || request.charName || ''}`.trim();
  const recipeCode = `${request.recipeCode || ''}`.trim();
  const quantity = Math.max(0, Math.floor(Number(request.quantity) || 0));

  if (!sourceType || !sourceCode || !itemCode || !requesterName || quantity <= 0) {
    return null;
  }

  const atMs = nowMs();
  const key = mergeKeyFor(sourceType, sourceCode, itemCode);
  const contributionKey = normalizeContributionKey(requesterName, recipeCode);

  let order = findByMergeKey(key);
  if (!order) {
    order = {
      id: randomUUID(),
      mergeKey: key,
      itemCode,
      sourceType,
      sourceCode,
      gatherSkill: sourceType === 'gather' ? `${request.gatherSkill || ''}`.trim() || null : null,
      craftSkill: sourceType === 'craft' ? `${request.craftSkill || ''}`.trim() || null : null,
      sourceLevel: Math.max(0, Math.floor(Number(request.sourceLevel) || 0)),
      requestedQty: 0,
      remainingQty: 0,
      status: 'open',
      requesters: [],
      recipes: [],
      contributions: {},
      claim: null,
      blockedByChar: {},
      createdAtMs: atMs,
      updatedAtMs: atMs,
      fulfilledAtMs: null,
    };
    orders.set(order.id, order);
  }

  if (order.status === 'fulfilled') {
    order.remainingQty = 0;
    order.fulfilledAtMs = atMs;
    order.claim = null;
  }

  const existingContribution = Number(order.contributions[contributionKey]) || 0;
  if (existingContribution <= 0) {
    order.contributions[contributionKey] = quantity;
    order.requestedQty += quantity;
    order.remainingQty += quantity;
  } else if (quantity > existingContribution) {
    const delta = quantity - existingContribution;
    order.contributions[contributionKey] = quantity;
    order.requestedQty += delta;
    order.remainingQty += delta;
  }

  if (!order.requesters.includes(requesterName)) {
    order.requesters.push(requesterName);
  }
  if (recipeCode && !order.recipes.includes(recipeCode)) {
    order.recipes.push(recipeCode);
  }

  order.updatedAtMs = atMs;
  ensureStatus(order, atMs);
  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return cloneOrder(order);
}

export function listClaimableOrders(query = {}) {
  if (!initialized) return [];

  const atMs = nowMs();
  const sourceType = normalizeSourceType(query.sourceType) || null;
  const gatherSkill = query.gatherSkill ? `${query.gatherSkill}`.trim() : '';
  const craftSkill = query.craftSkill ? `${query.craftSkill}`.trim() : '';
  const charName = query.charName ? `${query.charName}`.trim() : '';

  const rows = [];
  for (const order of getSortedOrders(atMs)) {
    if (order.status !== 'open') continue;
    if (sourceType && order.sourceType !== sourceType) continue;
    if (gatherSkill && order.gatherSkill !== gatherSkill) continue;
    if (craftSkill && order.craftSkill !== craftSkill) continue;

    if (charName) {
      const blockedUntil = Number(order.blockedByChar?.[charName]) || 0;
      if (blockedUntil > atMs) continue;
    }

    rows.push(cloneOrder(order));
  }

  return rows;
}

export function claimOrder(orderId, claimOpts = {}) {
  if (!initialized) return null;

  const order = orders.get(orderId);
  if (!order) return null;

  const charName = `${claimOpts.charName || ''}`.trim();
  if (!charName) return null;

  const atMs = nowMs();
  ensureStatus(order, atMs);
  if (order.status === 'fulfilled') return null;

  const blockedUntil = Number(order.blockedByChar?.[charName]) || 0;
  if (blockedUntil > atMs) return null;

  const leaseMs = toPositiveInt(claimOpts.leaseMs, DEFAULT_LEASE_MS);
  if (order.claim && order.claim.expiresAtMs > atMs && order.claim.charName !== charName) {
    return null;
  }

  order.claim = {
    charName,
    claimedAtMs: order.claim?.claimedAtMs || atMs,
    leaseMs,
    expiresAtMs: atMs + leaseMs,
  };

  order.updatedAtMs = atMs;
  ensureStatus(order, atMs);
  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return cloneOrder(order);
}

export function renewClaim(orderId, claimOpts = {}) {
  if (!initialized) return null;

  const order = orders.get(orderId);
  if (!order) return null;

  const charName = `${claimOpts.charName || ''}`.trim();
  if (!charName) return null;

  const atMs = nowMs();
  ensureStatus(order, atMs);
  if (!order.claim) return null;
  if (order.claim.charName !== charName) return null;
  if (order.claim.expiresAtMs <= atMs) return null;

  const leaseMs = toPositiveInt(claimOpts.leaseMs || order.claim.leaseMs, DEFAULT_LEASE_MS);
  order.claim.leaseMs = leaseMs;
  order.claim.expiresAtMs = atMs + leaseMs;
  order.updatedAtMs = atMs;

  ensureStatus(order, atMs);
  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return cloneOrder(order);
}

export function releaseClaim(orderId, releaseOpts = {}) {
  if (!initialized) return null;

  const order = orders.get(orderId);
  if (!order) return null;

  const atMs = nowMs();
  ensureStatus(order, atMs);
  if (!order.claim) return cloneOrder(order);

  const charName = `${releaseOpts.charName || ''}`.trim();
  if (charName && order.claim.charName !== charName) {
    return null;
  }

  order.claim = null;
  order.updatedAtMs = atMs;
  ensureStatus(order, atMs);

  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return cloneOrder(order);
}

export function markCharBlocked(orderId, blockOpts = {}) {
  if (!initialized) return null;

  const order = orders.get(orderId);
  if (!order) return null;

  const charName = `${blockOpts.charName || ''}`.trim();
  if (!charName) return null;

  const blockedRetryMs = toPositiveInt(blockOpts.blockedRetryMs, DEFAULT_BLOCKED_RETRY_MS);
  const atMs = nowMs();

  ensureStatus(order, atMs);
  order.blockedByChar[charName] = atMs + blockedRetryMs;

  if (order.claim?.charName === charName) {
    order.claim = null;
  }

  order.updatedAtMs = atMs;
  ensureStatus(order, atMs);
  markUpdated(atMs);
  schedulePersist();
  emitChange();

  return cloneOrder(order);
}

export function recordDeposits({ charName, items } = {}) {
  if (!initialized) return [];

  const claimer = `${charName || ''}`.trim();
  if (!claimer) return [];

  const totals = new Map();
  for (const row of (Array.isArray(items) ? items : [])) {
    const code = `${row?.code || ''}`.trim();
    const qty = Math.max(0, Math.floor(Number(row?.quantity || row?.qty) || 0));
    if (!code || qty <= 0) continue;
    totals.set(code, (totals.get(code) || 0) + qty);
  }
  if (totals.size === 0) return [];

  const atMs = nowMs();
  const changed = [];

  for (const order of getSortedOrders(atMs)) {
    if (order.status === 'fulfilled') continue;
    if (!order.claim || order.claim.charName !== claimer) continue;

    const available = totals.get(order.itemCode) || 0;
    if (available <= 0) continue;

    const consumed = Math.min(available, order.remainingQty);
    if (consumed <= 0) continue;

    order.remainingQty -= consumed;
    totals.set(order.itemCode, available - consumed);
    order.updatedAtMs = atMs;

    ensureStatus(order, atMs);
    changed.push({ orderId: order.id, itemCode: order.itemCode, quantity: consumed, status: order.status });
  }

  if (changed.length > 0) {
    markUpdated(atMs);
    schedulePersist();
    emitChange();
  }

  return changed;
}

export function getOrderBoardSnapshot() {
  const atMs = nowMs();
  const list = getSortedOrders(atMs).map(cloneOrder);

  return {
    updatedAtMs: updatedAtMs || atMs,
    orders: list,
  };
}

export function subscribeOrderBoardEvents(listener) {
  if (typeof listener !== 'function') {
    throw new Error('subscribeOrderBoardEvents(listener) requires a function');
  }

  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export async function flushOrderBoard() {
  if (!initialized) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await queuePersistWrite();
}

export function clearOrderBoard(reason = 'manual_clear') {
  if (!initialized) return { cleared: 0 };

  const cleared = orders.size;
  orders = new Map();

  const atMs = nowMs();
  markUpdated(atMs);
  schedulePersist();
  emitChange();
  log.info(`[OrderBoard] Cleared ${cleared} order(s): ${reason}`);
  return { cleared };
}

export function releaseClaimsForChars(charNames = [], reason = 'runtime_cleanup') {
  if (!initialized) return [];

  const set = new Set((Array.isArray(charNames) ? charNames : []).map(name => `${name || ''}`.trim()).filter(Boolean));
  if (set.size === 0) return [];

  const atMs = nowMs();
  const released = [];

  for (const order of getSortedOrders(atMs)) {
    if (!order.claim) continue;
    if (!set.has(order.claim.charName)) continue;

    const claimedBy = order.claim.charName;
    order.claim = null;
    order.updatedAtMs = atMs;
    ensureStatus(order, atMs);
    released.push({ orderId: order.id, reason, charName: claimedBy });
  }

  if (released.length > 0) {
    markUpdated(atMs);
    schedulePersist();
    emitChange();
  }

  return released;
}

export function _resetOrderBoardForTests() {
  initialized = false;
  boardPath = process.env.ORDER_BOARD_PATH || DEFAULT_BOARD_PATH;
  orders = new Map();
  updatedAtMs = 0;
  subscribers = new Set();

  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  persistWritePromise = Promise.resolve();
  persistQueued = false;
}
