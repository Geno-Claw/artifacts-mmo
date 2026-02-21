/**
 * Task coin exchange executor — proactively exchange task coins for rewards.
 *
 * All cross-calls go through routine._* wrappers so tests can monkey-patch methods.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import { moveTo } from '../../helpers.mjs';
import { depositBankItems, withdrawBankItems } from '../../services/bank-ops.mjs';
import { TASKS_MASTER } from '../../data/locations.mjs';
import { TASK_COIN_CODE, TASK_EXCHANGE_COST, PROACTIVE_EXCHANGE_BACKOFF_MS } from './constants.mjs';

let taskExchangeLockHolder = null;

export function collectExchangeTargets(routine, { extraNeedItemCode = '' } = {}) {
  const targets = typeof routine.rotation?.getExchangeTargets === 'function'
    ? routine.rotation.getExchangeTargets()
    : new Map();
  const code = `${extraNeedItemCode || ''}`.trim();
  if (code && routine._isTaskRewardCode(code)) {
    targets.set(code, Math.max(targets.get(code) || 0, 1));
  }
  return targets;
}

export function computeUnmetTargets(ctx, targets, bankItems) {
  const unmet = new Map();
  const bank = bankItems instanceof Map ? bankItems : new Map();

  for (const [code, rawTarget] of targets) {
    const target = Math.max(0, Math.floor(Number(rawTarget) || 0));
    if (!code || target <= 0) continue;
    const have = (bank.get(code) || 0) + ctx.itemCount(code);
    if (have < target) unmet.set(code, target - have);
  }
  return unmet;
}

export function inventorySnapshotForTargets(ctx, targets) {
  const snapshot = new Map();
  for (const code of targets.keys()) {
    snapshot.set(code, ctx.itemCount(code));
  }
  return snapshot;
}

export async function ensureExchangeCoinsInInventory(ctx, minCoins = TASK_EXCHANGE_COST) {
  const invCoins = ctx.itemCount(TASK_COIN_CODE);
  if (invCoins >= minCoins) {
    return { ok: true, available: invCoins };
  }

  const needed = Math.max(0, minCoins - invCoins);
  if (needed <= 0) {
    return { ok: true, available: invCoins };
  }

  const result = await withdrawBankItems(ctx, [{ code: TASK_COIN_CODE, quantity: needed }], {
    reason: 'task exchange coin withdrawal',
    mode: 'partial',
    retryStaleOnce: true,
  });
  for (const row of result.failed) {
    log.warn(`[${ctx.name}] Task Exchange: coin withdrawal failed for ${row.code}: ${row.error}`);
  }

  const refreshedInv = ctx.itemCount(TASK_COIN_CODE);
  const ok = refreshedInv >= minCoins;
  return { ok, available: refreshedInv };
}

export async function depositTargetRewardsToBank(ctx, targets, beforeInvSnapshot = new Map()) {
  const deposits = [];
  for (const code of targets.keys()) {
    const before = beforeInvSnapshot.get(code) || 0;
    const now = ctx.itemCount(code);
    const gained = now - before;
    if (gained > 0) {
      deposits.push({ code, quantity: gained });
    }
  }
  if (deposits.length === 0) return [];

  try {
    return await depositBankItems(ctx, deposits, {
      reason: 'task exchange reward deposit',
    });
  } catch (err) {
    log.warn(`[${ctx.name}] Task Exchange: reward deposit failed: ${err.message}`);
    return [];
  }
}

export async function performTaskExchange(ctx) {
  await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
  const result = await api.taskExchange(ctx.name);
  ctx.applyActionResult(result);
  await api.waitForCooldown(result);
}

export async function runTaskExchange(
  ctx,
  routine,
  { targets = null, trigger = 'unknown', proactive = false, extraNeedItemCode = '' } = {},
) {
  let targetMap = targets instanceof Map
    ? new Map(targets)
    : routine._collectExchangeTargets({ extraNeedItemCode });
  const extraCode = `${extraNeedItemCode || ''}`.trim();
  if (extraCode && routine._isTaskRewardCode(extraCode)) {
    targetMap.set(extraCode, Math.max(targetMap.get(extraCode) || 0, 1));
  }
  if (targetMap.size === 0) {
    return { attempted: false, exchanged: 0, resolved: true, reason: 'no_targets' };
  }

  if (taskExchangeLockHolder && taskExchangeLockHolder !== ctx.name) {
    return { attempted: false, exchanged: 0, resolved: false, reason: 'lock_busy' };
  }

  taskExchangeLockHolder = ctx.name;
  try {
    let bank = await routine._getBankItems(true);
    let unmet = routine._computeUnmetTargets(ctx, targetMap, bank);
    if (unmet.size === 0) {
      return { attempted: false, exchanged: 0, resolved: true, reason: 'targets_met' };
    }

    let attempted = false;
    let exchanged = 0;
    let reason = 'targets_unmet';

    while (unmet.size > 0) {
      const coinStatus = await routine._ensureExchangeCoinsInInventory(ctx, TASK_EXCHANGE_COST);
      if (!coinStatus.ok) {
        reason = 'insufficient_coins';
        break;
      }

      if (ctx.inventoryCount() + 2 >= ctx.inventoryCapacity()) {
        reason = 'inventory_full';
        break;
      }

      attempted = true;
      const beforeInv = routine._inventorySnapshotForTargets(ctx, targetMap);

      try {
        await routine._performTaskExchange(ctx);
        exchanged += 1;
        log.info(`[${ctx.name}] Task Exchange (${trigger}): exchanged ${TASK_EXCHANGE_COST} coins (${ctx.taskCoins()} available)`);
      } catch (err) {
        reason = `exchange_failed:${err.code || 'unknown'}`;
        log.warn(`[${ctx.name}] Task Exchange (${trigger}) failed: ${err.message}`);
        break;
      }

      await routine._depositTargetRewardsToBank(ctx, targetMap, beforeInv);
      bank = await routine._getBankItems(true);
      unmet = routine._computeUnmetTargets(ctx, targetMap, bank);
    }

    const resolved = unmet.size === 0;
    if (resolved) {
      if (attempted) {
        log.info(`[${ctx.name}] Task Exchange (${trigger}): targets met`);
      }
      return { attempted, exchanged, resolved: true, reason: 'targets_met' };
    }

    if (!attempted && reason === 'targets_unmet') {
      reason = 'deferred';
    }
    if (proactive && reason === 'lock_busy') {
      return { attempted: false, exchanged, resolved: false, reason };
    }
    return { attempted, exchanged, resolved: false, reason };
  } finally {
    if (taskExchangeLockHolder === ctx.name) {
      taskExchangeLockHolder = null;
    }
  }
}

export async function maybeRunProactiveExchange(ctx, routine, { extraNeedItemCode = '', trigger = 'proactive' } = {}) {
  const now = routine._nowMs();
  if (now < routine._nextProactiveExchangeAt) {
    return { attempted: false, exchanged: 0, resolved: false, reason: 'backoff' };
  }

  const targets = routine._collectExchangeTargets({ extraNeedItemCode });
  if (targets.size === 0) {
    return { attempted: false, exchanged: 0, resolved: true, reason: 'no_targets' };
  }

  const result = await routine._runTaskExchange(ctx, {
    targets,
    trigger,
    proactive: true,
    extraNeedItemCode,
  });
  if (!result.resolved) {
    routine._nextProactiveExchangeAt = routine._nowMs() + PROACTIVE_EXCHANGE_BACKOFF_MS;
  } else {
    routine._nextProactiveExchangeAt = 0;
  }
  return result;
}

export async function exchangeTaskCoins(ctx, routine) {
  const targets = routine._collectExchangeTargets();
  if (targets.size === 0) return;
  await routine._runTaskExchange(ctx, {
    targets,
    trigger: 'task_completion',
    proactive: false,
  });
}
