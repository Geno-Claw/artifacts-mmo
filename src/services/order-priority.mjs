import * as gameData from './game-data.mjs';

const ORDER_CLAIM_PRIORITY = Object.freeze({
  tool: 0,
  resource: 1,
  weapon: 2,
  gear: 3,
});

const DEFAULT_PRIORITY = ORDER_CLAIM_PRIORITY.resource;
const FALLBACK_BUCKET = 'resource';
const MAX_CREATED_AT = Number.MAX_SAFE_INTEGER;

let _deps = {
  gameDataSvc: gameData,
};

function toCreatedAt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return MAX_CREATED_AT;
  return Math.floor(num);
}

function isToolItem(item) {
  return item?.type === 'weapon' && item?.subtype === 'tool';
}

function getOrderItem(order) {
  const code = `${order?.itemCode || ''}`.trim();
  if (!code) return null;
  return _deps.gameDataSvc.getItem(code);
}

export function getOrderClaimBucket(order = {}) {
  const item = getOrderItem(order);
  if (!item || typeof item !== 'object') return FALLBACK_BUCKET;

  if (isToolItem(item)) return 'tool';
  if (!_deps.gameDataSvc.isEquipmentType(item)) return 'resource';
  if (item.type === 'weapon') return 'weapon';
  return 'gear';
}

export function getOrderClaimPriority(order = {}) {
  const bucket = getOrderClaimBucket(order);
  return ORDER_CLAIM_PRIORITY[bucket] ?? DEFAULT_PRIORITY;
}

function compareOrdersForClaim(a, b) {
  const priorityDelta = getOrderClaimPriority(a) - getOrderClaimPriority(b);
  if (priorityDelta !== 0) return priorityDelta;

  const createdAtDelta = toCreatedAt(a?.createdAtMs) - toCreatedAt(b?.createdAtMs);
  if (createdAtDelta !== 0) return createdAtDelta;

  const idA = `${a?.id || ''}`;
  const idB = `${b?.id || ''}`;
  return idA.localeCompare(idB);
}

export function sortOrdersForClaim(orders = []) {
  const rows = Array.isArray(orders) ? [...orders] : [];
  rows.sort(compareOrdersForClaim);
  return rows;
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  _deps = {
    ..._deps,
    ...input,
  };
}

export function _resetForTests() {
  _deps = {
    gameDataSvc: gameData,
  };
}
