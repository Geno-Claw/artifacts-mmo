/**
 * Order board claim management — acquire, renew, sync, and release claims.
 */
import * as log from '../../log.mjs';
import {
  claimOrder,
  getOrderBoardSnapshot,
  listClaimableOrders,
  markCharBlocked,
  releaseClaim,
  renewClaim,
} from '../../services/order-board.mjs';
import { depositBankItems } from '../../services/bank-ops.mjs';
import { sortOrdersForClaim } from '../../services/order-priority.mjs';

export async function clearActiveOrderClaim(ctx, routine, { reason = 'clear_claim' } = {}) {
  const active = routine._activeOrderClaim;
  if (!active) return;

  routine._activeOrderClaim = null;
  try {
    releaseClaim(active.orderId, { charName: ctx.name, reason });
  } catch (err) {
    log.warn(`[${ctx.name}] Order claim release failed (${active.orderId}): ${err?.message || String(err)}`);
  }
}

export function resolveOrderById(routine, orderId) {
  if (!orderId) return null;
  const snapshot = getOrderBoardSnapshot();
  return snapshot.orders.find(order => order.id === orderId) || null;
}

export function syncActiveClaimFromBoard(routine) {
  if (!routine._activeOrderClaim) return null;

  const order = resolveOrderById(routine, routine._activeOrderClaim.orderId);
  if (!order || order.status === 'fulfilled') {
    routine._activeOrderClaim = null;
    return null;
  }

  if (order.claim?.charName !== routine._activeOrderClaim.charName) {
    routine._activeOrderClaim = null;
    return null;
  }

  routine._activeOrderClaim = {
    ...routine._activeOrderClaim,
    itemCode: order.itemCode,
    sourceType: order.sourceType,
    sourceCode: order.sourceCode,
    gatherSkill: order.gatherSkill || null,
    craftSkill: order.craftSkill || null,
    sourceLevel: order.sourceLevel || 0,
    remainingQty: order.remainingQty,
    claim: order.claim,
  };

  return routine._activeOrderClaim;
}

export function claimOrderForChar(ctx, routine, order) {
  if (!order) return null;
  const claimed = claimOrder(order.id, {
    charName: ctx.name,
    leaseMs: routine.orderBoard.leaseMs,
  });
  if (!claimed) return null;

  const active = {
    orderId: claimed.id,
    charName: ctx.name,
    itemCode: claimed.itemCode,
    sourceType: claimed.sourceType,
    sourceCode: claimed.sourceCode,
    gatherSkill: claimed.gatherSkill || null,
    craftSkill: claimed.craftSkill || null,
    sourceLevel: claimed.sourceLevel || 0,
    remainingQty: claimed.remainingQty,
    claim: claimed.claim,
  };
  routine._activeOrderClaim = active;
  log.info(`[${ctx.name}] Order claim: ${claimed.itemCode} via ${claimed.sourceType}:${claimed.sourceCode} (remaining ${claimed.remainingQty})`);
  return active;
}

export async function acquireGatherOrderClaim(ctx, routine) {
  const orders = sortOrdersForClaim(listClaimableOrders({
    sourceType: 'gather',
    gatherSkill: routine.rotation.currentSkill,
    charName: ctx.name,
  }));

  for (const order of orders) {
    const active = routine._claimOrderForChar(ctx, order);
    if (active) return active;
  }
  return null;
}

export async function acquireCombatOrderClaim(ctx, routine) {
  const orders = sortOrdersForClaim(listClaimableOrders({
    sourceType: 'fight',
    charName: ctx.name,
  }));

  for (const order of orders) {
    const sim = await routine._simulateClaimFight(ctx, order.sourceCode);
    if (!sim || !sim.simResult?.win || sim.simResult.hpLostPercent > 90) continue;

    const active = routine._claimOrderForChar(ctx, order);
    if (active) return active;
  }
  return null;
}

export function blockUnclaimableOrderForChar(routine, order, ctx, reason = 'cannot_complete') {
  try {
    markCharBlocked(order.id, {
      charName: ctx.name,
      blockedRetryMs: routine.orderBoard.blockedRetryMs,
    });
    log.info(`[${ctx.name}] Order claim skipped (${reason}): ${order.itemCode} via ${order.sourceType}:${order.sourceCode}`);
  } catch (err) {
    log.warn(`[${ctx.name}] Could not block unclaimable order ${order?.id || 'unknown'}: ${err?.message || String(err)}`);
  }
}

export async function canClaimCraftOrderNow(ctx, routine, order, craftSkill, bank, simCache) {
  const item = routine._getCraftClaimItem(order);
  if (!item?.craft?.skill) {
    return { ok: false, reason: 'invalid_craft_order' };
  }
  if (item.craft.skill !== craftSkill) {
    return { ok: false, reason: 'wrong_craft_skill' };
  }
  if (item.craft.level > ctx.skillLevel(craftSkill)) {
    return { ok: false, reason: 'insufficient_craft_level' };
  }

  const plan = routine._resolveRecipeChain(item.craft);
  if (!plan || plan.length === 0) {
    return { ok: false, reason: 'unresolvable_recipe_chain' };
  }

  const bankItems = bank instanceof Map ? bank : new Map();

  // Bank-aware plan check: skip gather/craft skill checks when bank+inventory covers the need
  const planCheck = routine._canFulfillCraftClaimPlanWithBank(plan, ctx, bankItems);
  if (!planCheck.ok) {
    const firstDeficit = planCheck.deficits[0];
    if (firstDeficit?.type === 'craft') {
      return { ok: false, reason: `insufficient_craft_skill:${firstDeficit.itemCode}` };
    }
    return { ok: false, reason: 'insufficient_gather_skill', deficits: planCheck.deficits };
  }

  for (const step of plan) {
    if (step.type !== 'bank') continue;
    const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
    if (have < step.quantity) {
      return { ok: false, reason: `missing_bank_dependency:${step.itemCode}` };
    }
  }

  for (const step of plan) {
    if (step.type !== 'fight') continue;

    const monsterCode = step.monster?.code;
    if (!monsterCode) {
      return { ok: false, reason: `invalid_fight_step:${step.itemCode || 'unknown'}` };
    }

    const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
    if (have >= step.quantity) continue;

    if (!simCache.has(monsterCode)) {
      simCache.set(monsterCode, await routine._simulateClaimFight(ctx, monsterCode));
    }

    const sim = simCache.get(monsterCode);
    const simResult = sim?.simResult;
    if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
      return { ok: false, reason: `combat_not_viable:${monsterCode}` };
    }
  }

  return { ok: true, reason: '' };
}

export async function acquireCraftOrderClaim(ctx, routine, craftSkill) {
  const orders = sortOrdersForClaim(listClaimableOrders({
    sourceType: 'craft',
    craftSkill,
    charName: ctx.name,
  }));
  let bank = await routine._getBankItems();
  const simCache = new Map();

  for (const order of orders) {
    let viability = await routine._canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache);
    if (!viability.ok) {
      const missingCode = routine._parseMissingBankDependency(viability.reason);
      if (missingCode && routine._isTaskRewardCode(missingCode)) {
        const proactive = await routine._maybeRunProactiveExchange(ctx, {
          extraNeedItemCode: missingCode,
          trigger: 'craft_claim',
        });
        if (proactive.attempted || proactive.resolved) {
          bank = await routine._getBankItems(true);
          viability = await routine._canClaimCraftOrderNow(ctx, order, craftSkill, bank, simCache);
        }
      }
    }
    if (!viability.ok) {
      // Queue gather orders for deficit materials so other characters can help
      if (viability.reason === 'insufficient_gather_skill' && viability.deficits?.length > 0) {
        for (const step of viability.deficits) {
          if (step.type !== 'gather' || !step.resource) continue;
          const bankItems = bank instanceof Map ? bank : new Map();
          const deficit = step.quantity - ctx.itemCount(step.itemCode) - (bankItems.get(step.itemCode) || 0);
          if (deficit > 0) {
            routine._enqueueGatherOrderForDeficit(step, order, ctx, deficit);
          }
        }
      }
      // Queue fight orders for combat drops that this character can't obtain
      if (viability.reason?.startsWith('combat_not_viable:')) {
        const item = routine._getCraftClaimItem(order);
        const plan = item?.craft ? routine._resolveRecipeChain(item.craft) : null;
        if (plan) {
          const bankItems = bank instanceof Map ? bank : new Map();
          for (const step of plan) {
            if (step.type !== 'fight' || !step.monster) continue;
            const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
            const deficit = step.quantity - have;
            if (deficit > 0) {
              routine._enqueueFightOrderForDeficit(step, order, ctx, deficit);
            }
          }
        }
      }
      routine._blockUnclaimableOrderForChar(order, ctx, viability.reason);
      continue;
    }

    const active = routine._claimOrderForChar(ctx, order);
    if (active) return active;
  }

  return null;
}

export async function ensureOrderClaim(ctx, routine, sourceType, opts = {}) {
  if (!routine._canFulfillOrders()) return null;
  const craftSkill = opts.craftSkill ? `${opts.craftSkill}`.trim() : '';

  const active = routine._syncActiveClaimFromBoard();
  if (active && active.sourceType !== sourceType) {
    await routine._clearActiveOrderClaim(ctx, { reason: 'source_type_changed' });
    return null;
  }
  if (active && sourceType === 'craft' && craftSkill && active.craftSkill && active.craftSkill !== craftSkill) {
    await routine._clearActiveOrderClaim(ctx, { reason: 'craft_skill_changed' });
    return null;
  }

  if (active) {
    const renewed = renewClaim(active.orderId, {
      charName: ctx.name,
      leaseMs: routine.orderBoard.leaseMs,
    });
    if (!renewed) {
      routine._activeOrderClaim = null;
      return null;
    }
    return routine._syncActiveClaimFromBoard();
  }

  if (sourceType === 'gather') {
    return routine._acquireGatherOrderClaim(ctx);
  }
  if (sourceType === 'fight') {
    return routine._acquireCombatOrderClaim(ctx);
  }
  if (sourceType === 'craft' && craftSkill) {
    return routine._acquireCraftOrderClaim(ctx, craftSkill);
  }
  return null;
}

export async function depositClaimItemsIfNeeded(ctx, routine, { force = false } = {}) {
  const prevClaim = routine._activeOrderClaim;
  let claim = routine._syncActiveClaimFromBoard();

  // Lease expired but we still remember the order — try to reclaim
  if (!claim && prevClaim) {
    const order = routine._resolveOrderById(prevClaim.orderId);
    if (order && order.status !== 'fulfilled' && !order.claim) {
      log.info(`[${ctx.name}] Lease expired for order ${prevClaim.orderId}, reclaiming`);
      claim = routine._claimOrderForChar(ctx, order);
    }
  }

  if (!claim) return false;

  const carried = ctx.itemCount(claim.itemCode);
  if (carried <= 0) return false;

  const shouldDeposit = force || carried >= claim.remainingQty || ctx.inventoryFull();
  if (!shouldDeposit) return false;

  await depositBankItems(ctx, [{ code: claim.itemCode, quantity: carried }], {
    reason: `order claim ${claim.orderId}`,
  });
  const fresh = routine._syncActiveClaimFromBoard();
  if (!fresh) {
    log.info(`[${ctx.name}] Order fulfilled: ${claim.itemCode}`);
  } else {
    log.info(`[${ctx.name}] Order progress: ${fresh.itemCode} remaining ${fresh.remainingQty}`);
  }
  return true;
}

export function enqueueGatherOrderForDeficit(routine, step, order, ctx, deficit) {
  if (!step?.resource || !routine.rotation) return;
  try {
    routine.rotation._enqueueOrder({
      requesterName: ctx.name,
      recipeCode: order?.itemCode || '',
      itemCode: step.itemCode,
      sourceType: 'gather',
      sourceCode: step.resource.code,
      gatherSkill: step.resource.skill,
      sourceLevel: step.resource.level,
      quantity: Math.max(1, Math.floor(Number(deficit) || 0)),
    });
    log.info(`[${ctx.name}] Order claim: queued gather order for ${step.itemCode} x${deficit} (${step.resource.skill} lv${step.resource.level})`);
  } catch (err) {
    log.warn(`[${ctx.name}] Could not queue gather order for ${step.itemCode}: ${err?.message || String(err)}`);
  }
}

export function enqueueFightOrderForDeficit(routine, step, order, ctx, deficit) {
  if (!step?.monster || !routine.rotation) return;
  try {
    routine.rotation._enqueueOrder({
      requesterName: ctx.name,
      recipeCode: order?.itemCode || '',
      itemCode: step.itemCode,
      sourceType: 'fight',
      sourceCode: step.monster.code,
      sourceLevel: step.monster.level,
      quantity: Math.max(1, Math.floor(Number(deficit) || 0)),
    });
    log.info(`[${ctx.name}] Order claim: queued fight order for ${step.itemCode} x${deficit} from ${step.monster.code}`);
  } catch (err) {
    log.warn(`[${ctx.name}] Could not queue fight order for ${step.itemCode}: ${err?.message || String(err)}`);
  }
}

export async function blockAndReleaseClaim(ctx, routine, reason = 'blocked') {
  const claim = routine._syncActiveClaimFromBoard();
  if (!claim) return;

  try {
    markCharBlocked(claim.orderId, {
      charName: ctx.name,
      blockedRetryMs: routine.orderBoard.blockedRetryMs,
    });
    log.info(`[${ctx.name}] Order claim blocked (${reason}): ${claim.itemCode} via ${claim.sourceCode}`);
  } catch (err) {
    log.warn(`[${ctx.name}] Could not block claim ${claim.orderId}: ${err?.message || String(err)}`);
  } finally {
    routine._activeOrderClaim = null;
  }
}
