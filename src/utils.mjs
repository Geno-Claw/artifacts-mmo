/**
 * Shared utility functions.
 */
import * as log from './log.mjs';

/**
 * Coerce a value to a positive integer, returning `fallback` when the input
 * is not a finite number > 0.
 */
export function toPositiveInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

/**
 * Log warnings for failed/skipped items from a bank withdrawal result.
 * Suppresses "partial fill" skip reasons (expected in partial mode).
 *
 * @param {import('./context.mjs').CharacterContext} ctx
 * @param {{ failed?: Array, skipped?: Array }} result — from withdrawBankItems
 * @param {string} context — log prefix (e.g. "Food", "combat gear")
 */
export function logWithdrawalWarnings(ctx, result, context = '') {
  const prefix = context ? `${context}: ` : '';
  for (const row of result.failed || []) {
    log.warn(`[${ctx.name}] ${prefix}could not withdraw ${row.code}: ${row.error}`);
  }
  for (const row of result.skipped || []) {
    if (!row.reason.startsWith('partial fill')) {
      log.warn(`[${ctx.name}] ${prefix}skipped ${row.code} (${row.reason})`);
    }
  }
}
