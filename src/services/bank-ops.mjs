/**
 * Bank operations.
 * Centralizes reservation-aware bank item flows and keeps all bank actions
 * behind one location-guarded service.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { toPositiveInt } from '../utils.mjs';
import { recordDeposits } from './order-board.mjs';
import {
  applyBankDelta,
  applyBankGoldDelta,
  availableBankCount,
  getBankItems,
  invalidateBank,
  release,
  reserve,
  reserveMany,
} from './inventory-manager.mjs';
import {
  ensureAtBank,
  _setApiClient as _setBankTravelApiClient,
  _resetForTests as _resetBankTravelForTests,
} from './bank-travel.mjs';

let _api = api;
let _forcedBatchReserveFailures = 0;

function _normalizeByCode(items, qtyField) {
  const totals = new Map();
  const order = [];

  for (const row of items) {
    const code = row?.code;
    const qty = toPositiveInt(row?.qty ?? row?.quantity);
    if (!code || qty <= 0) continue;
    if (!totals.has(code)) order.push(code);
    totals.set(code, (totals.get(code) || 0) + qty);
  }

  return order.map(code => ({ code, [qtyField]: totals.get(code) }));
}

function normalizeItemRows(items = []) {
  return _normalizeByCode(items, 'quantity');
}

function normalizeRequests(requests = []) {
  return _normalizeByCode(requests, 'requested');
}

function normalizeKeepByCode(keepByCode = {}) {
  if (!keepByCode || typeof keepByCode !== 'object') return new Map();
  const out = new Map();

  for (const [code, rawQty] of Object.entries(keepByCode)) {
    const qty = toPositiveInt(rawQty);
    if (!code || qty <= 0) continue;
    out.set(code, qty);
  }

  return out;
}

function buildPlan(ctx, normalized, mode) {
  const plan = [];
  const skipped = [];

  let remainingSpace = Math.max(0, ctx.inventoryCapacity() - ctx.inventoryCount());
  let remainingSlots = Math.max(0, ctx.inventoryEmptySlots());
  // Track which items we've already planned to withdraw (they'll occupy a slot)
  const plannedCodes = new Set(
    (ctx.get().inventory || []).filter(s => s.code && s.quantity > 0).map(s => s.code),
  );

  for (const req of normalized) {
    const needsNewSlot = !plannedCodes.has(req.code);
    if (remainingSpace <= 0 || (needsNewSlot && remainingSlots <= 0)) {
      skipped.push({ code: req.code, requested: req.requested, reason: 'inventory full' });
      continue;
    }

    const available = availableBankCount(req.code, { includeChar: ctx.name });
    if (available <= 0) {
      skipped.push({ code: req.code, requested: req.requested, reason: 'not available in bank' });
      continue;
    }

    if (mode === 'strict') {
      if (available < req.requested) {
        skipped.push({
          code: req.code,
          requested: req.requested,
          reason: `strict mode: need ${req.requested}, available ${available}`,
        });
        continue;
      }
      if (remainingSpace < req.requested) {
        skipped.push({
          code: req.code,
          requested: req.requested,
          reason: `strict mode: need ${req.requested} slots, have ${remainingSpace}`,
        });
        continue;
      }
      plan.push({ code: req.code, requested: req.requested, quantity: req.requested });
      remainingSpace -= req.requested;
      if (needsNewSlot) { remainingSlots--; plannedCodes.add(req.code); }
      continue;
    }

    const qty = Math.min(req.requested, available, remainingSpace);
    if (qty <= 0) {
      skipped.push({ code: req.code, requested: req.requested, reason: 'not available in bank' });
      continue;
    }

    if (qty < req.requested) {
      skipped.push({ code: req.code, requested: req.requested, reason: `partial fill ${qty}/${req.requested}` });
    }

    plan.push({ code: req.code, requested: req.requested, quantity: qty });
    remainingSpace -= qty;
    if (needsNewSlot) { remainingSlots--; plannedCodes.add(req.code); }
  }

  return { plan, skipped };
}

export function isBankAvailabilityError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  if (isBankLocationError(err)) return false;
  return (
    msg.includes('not enough') ||
    msg.includes('insufficient') ||
    msg.includes('quantity') ||
    msg.includes('not found') ||
    msg.includes('does not exist')
  );
}

export function isBankLocationError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('bank not found on this map');
}

function tryReserveMany(requests, charName) {
  if (_forcedBatchReserveFailures > 0) {
    _forcedBatchReserveFailures -= 1;
    return { ok: false, reservations: [], reason: 'forced reserveMany failure (test)' };
  }
  return reserveMany(requests, charName);
}

async function executeReservedWithdraw(ctx, req, reservationId, reason, result) {
  let localReservationId = reservationId || null;
  const requested = toPositiveInt(req.requested || req.quantity);
  let qty = toPositiveInt(req.quantity);
  let createdReservationId = null;

  if (qty <= 0 || !req.code) return;

  if (!localReservationId) {
    localReservationId = reserve(req.code, qty, ctx.name);
    if (!localReservationId) {
      result.skipped.push({
        code: req.code,
        requested,
        reason: `could not reserve ${qty}`,
      });
      return;
    }
    createdReservationId = localReservationId;
  }

  if (qty < requested) {
    log.info(`[${ctx.name}] Withdrawing ${req.code}: requested ${requested}, only ${qty} available`);
  } else {
    log.info(`[${ctx.name}] Withdrawing ${req.code} x${qty}`);
  }

  try {
    const action = await _api.withdrawBank([{ code: req.code, quantity: qty }], ctx.name);
    ctx.applyActionResult(action);
    await _api.waitForCooldown(action);
    applyBankDelta([{ code: req.code, quantity: qty }], 'withdraw', {
      charName: ctx.name,
      reason,
    });
    result.withdrawn.push({ code: req.code, quantity: qty });
  } catch (err) {
    if (isBankAvailabilityError(err)) {
      invalidateBank(`[${ctx.name}] withdraw failed for ${req.code}: ${err.message}`);
    }
    result.failed.push({
      code: req.code,
      requested,
      error: err.message,
    });
  } finally {
    release(createdReservationId || reservationId);
  }
}

function pickRetryReason(summary) {
  const fromFailure = summary.failed.find(row => isBankAvailabilityError({ message: row.error }));
  if (fromFailure) return fromFailure.error;
  const fromSkipped = summary.skipped.find(row => row.reason.includes('not available') || row.reason.includes('could not reserve'));
  return fromSkipped?.reason || '';
}

/**
 * Withdraw one item from bank.
 * Returns the same shape as withdrawBankItems for consistency.
 */
export async function withdrawBankItem(ctx, code, quantity = 1, opts = {}) {
  return withdrawBankItems(ctx, [{ code, quantity }], opts);
}

/**
 * Withdraw multiple items from bank with reservation coordination.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Array<{code:string, quantity?:number, qty?:number}>} requests
 * @param {{
 *   reason?: string,
 *   mode?: 'partial' | 'strict',
 *   retryStaleOnce?: boolean,
 *   throwOnAllSkipped?: boolean
 * }} opts
 * @returns {Promise<{
 *   withdrawn: Array<{ code: string, quantity: number }>,
 *   skipped: Array<{ code: string, requested: number, reason: string }>,
 *   failed: Array<{ code: string, requested: number, error: string }>
 * }>}
 */
export async function withdrawBankItems(ctx, requests, opts = {}) {
  const reason = opts.reason || 'bank-ops withdrawal';
  const mode = opts.mode === 'strict' ? 'strict' : 'partial';
  const retryStaleOnce = opts.retryStaleOnce !== false;
  const throwOnAllSkipped = opts.throwOnAllSkipped === true;

  const result = {
    withdrawn: [],
    skipped: [],
    failed: [],
  };

  const normalized = normalizeRequests(requests);
  if (normalized.length === 0) return result;
  await ensureAtBank(ctx);

  let { plan, skipped } = buildPlan(ctx, normalized, mode);
  result.skipped.push(...skipped);

  let batch = tryReserveMany(plan.map(p => ({ code: p.code, qty: p.quantity })), ctx.name);

  if (!batch.ok && retryStaleOnce) {
    await getBankItems(true);
    ({ plan, skipped } = buildPlan(ctx, normalized, mode));
    result.skipped = [...skipped];
    batch = tryReserveMany(plan.map(p => ({ code: p.code, qty: p.quantity })), ctx.name);
  }

  if (batch.ok) {
    const reservationByCode = new Map(batch.reservations.map(r => [r.code, r.id]));
    for (const req of plan) {
      await executeReservedWithdraw(ctx, req, reservationByCode.get(req.code), reason, result);
    }
  } else {
    const reserveReason = batch.reason || 'reservation failed';
    log.warn(`[${ctx.name}] Could not reserve full withdrawal batch (${reserveReason}), falling back to per-item reservations`);
    for (const req of plan) {
      await executeReservedWithdraw(ctx, req, null, reason, result);
    }
  }

  if (
    retryStaleOnce &&
    result.withdrawn.length === 0 &&
    (result.failed.length > 0 || result.skipped.length > 0)
  ) {
    const retryReason = pickRetryReason(result);
    if (retryReason) {
      await getBankItems(true);
      const retry = await withdrawBankItems(ctx, requests, {
        ...opts,
        retryStaleOnce: false,
      });
      return retry;
    }
  }

  if (throwOnAllSkipped && result.withdrawn.length === 0) {
    const firstFailure = result.failed[0];
    const firstSkipped = result.skipped[0];
    const reasonText = firstFailure
      ? firstFailure.error
      : (firstSkipped?.reason || 'no items available');
    throw new Error(reasonText);
  }

  return result;
}

/**
 * Deposit specific items to bank.
 * Returns normalized deposited rows.
 */
export async function depositBankItems(ctx, items, opts = {}) {
  const reason = opts.reason || 'bank-ops deposit';
  const normalized = normalizeItemRows(items);
  if (normalized.length === 0) return [];

  await ensureAtBank(ctx);
  try {
    const action = await _api.depositBank(normalized, ctx.name);
    ctx.applyActionResult(action);
    await _api.waitForCooldown(action);
    applyBankDelta(normalized, 'deposit', {
      charName: ctx.name,
      reason,
    });
    try {
      const contributions = recordDeposits({ charName: ctx.name, items: normalized });
      for (const entry of contributions) {
        if (entry.opportunistic) {
          log.info(`[${ctx.name}] Opportunistic order contribution: ${entry.itemCode} x${entry.quantity} → order ${entry.orderId} (${entry.status})`);
        }
      }
    } catch (err) {
      log.warn(`[${ctx.name}] Order board deposit hook failed: ${err?.message || String(err)}`);
    }
    return normalized;
  } catch (err) {
    invalidateBank(`[${ctx.name}] deposit failed: ${err.message}`);
    throw err;
  }
}

/**
 * Deposit all carried inventory items to bank.
 * Returns normalized deposited rows.
 */
export async function depositAllInventory(ctx, opts = {}) {
  const keep = normalizeKeepByCode(opts.keepByCode);
  const keepRemainder = new Map(keep);

  const items = [];
  for (const slot of ctx.get().inventory) {
    const code = slot?.code;
    const quantity = toPositiveInt(slot?.quantity);
    if (!code || quantity <= 0) continue;

    const keepQty = keepRemainder.get(code) || 0;
    const depositQty = Math.max(0, quantity - keepQty);
    const nextKeep = Math.max(0, keepQty - quantity);
    keepRemainder.set(code, nextKeep);

    if (depositQty > 0) items.push({ code, quantity: depositQty });
  }

  if (items.length === 0) return [];

  log.info(`[${ctx.name}] Depositing ${items.length} item(s): ${items.map(i => `${i.code} x${i.quantity}`).join(', ')}`);
  return depositBankItems(ctx, items, {
    reason: opts.reason || 'bank-ops depositAllInventory',
  });
}

/**
 * Withdraw gold from bank.
 */
export async function withdrawGoldFromBank(ctx, quantity, _opts = {}) {
  const qty = toPositiveInt(quantity);
  if (qty <= 0) return null;
  await ensureAtBank(ctx);
  const action = await _api.withdrawGold(qty, ctx.name);
  ctx.applyActionResult(action);
  applyBankGoldDelta(qty, 'withdraw');
  await _api.waitForCooldown(action);
  return action;
}

/**
 * Deposit gold to bank.
 */
export async function depositGoldToBank(ctx, quantity, _opts = {}) {
  const qty = toPositiveInt(quantity);
  if (qty <= 0) return null;
  await ensureAtBank(ctx);
  const action = await _api.depositGold(qty, ctx.name);
  ctx.applyActionResult(action);
  applyBankGoldDelta(qty, 'deposit');
  await _api.waitForCooldown(action);
  return action;
}

// Test helpers.
export function _setApiClientForTests(client) {
  _api = client || api;
  _setBankTravelApiClient(client || api);
}

export function _resetForTests() {
  _api = api;
  _forcedBatchReserveFailures = 0;
  _setBankTravelApiClient(api);
  _resetBankTravelForTests();
}

export function _setForcedBatchReserveFailuresForTests(count) {
  _forcedBatchReserveFailures = Math.max(0, Number(count) || 0);
}
