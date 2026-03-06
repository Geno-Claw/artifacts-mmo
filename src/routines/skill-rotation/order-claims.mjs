/**
 * Order board claim management — acquire, renew, sync, and release claims.
 */
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import {
  claimOrder,
  getOrderBoardSnapshot,
  listClaimableOrders,
  markCharBlocked,
  releaseClaim,
  renewClaim,
} from '../../services/order-board.mjs';
import { depositBankItems, withdrawBankItems } from '../../services/bank-ops.mjs';
import { buyItemFromNpc, carriedCurrencyCount, bankCurrencyCount, topUpNpcCurrency } from '../../services/npc-purchase.mjs';
import { sortOrdersForClaim } from '../../services/order-priority.mjs';
import { moveTo, gatherOnce, fightOnce, parseFightResult, withdrawPlanFromBank, NoPathError } from '../../helpers.mjs';
import { restBeforeFight } from '../../services/food-manager.mjs';
import { hpNeededForFight } from '../../services/combat-simulator.mjs';
import { equipForGathering } from '../../services/gear-loadout.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';
import { TASK_COIN_CODE, TASK_EXCHANGE_COST } from './constants.mjs';

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

export async function acquireGatherOrderClaimAnySkill(ctx, routine) {
  const orders = sortOrdersForClaim(listClaimableOrders({
    sourceType: 'gather',
    charName: ctx.name,
  }));

  for (const order of orders) {
    const gatherSkill = `${order?.gatherSkill || ''}`.trim();
    const requiredLevel = Math.max(0, Number(order?.sourceLevel) || 0);
    if (gatherSkill && ctx.skillLevel(gatherSkill) < requiredLevel) {
      routine._blockUnclaimableOrderForChar(order, ctx, 'insufficient_skill');
      continue;
    }

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

function normalizeCraftSkill(value) {
  return `${value || ''}`.trim();
}

function resolveCraftSkillForOrder(routine, order) {
  const fromOrder = normalizeCraftSkill(order?.craftSkill);
  if (fromOrder) return fromOrder;
  const item = routine._getCraftClaimItem(order);
  return normalizeCraftSkill(item?.craft?.skill);
}

function craftSkillMatches(orderCraftSkill, requiredCraftSkill) {
  const required = normalizeCraftSkill(requiredCraftSkill);
  if (!required) return true;
  return orderCraftSkill === required;
}

function currencyCountWithBank(ctx, bankItems, currency) {
  return carriedCurrencyCount(ctx, currency) + bankCurrencyCount(currency, bankItems);
}

function resolveNpcBuyPlanForOrder(routine, order, quantity = null) {
  const qty = quantity == null
    ? Math.max(1, Number(order?.remainingQty) || 1)
    : Math.max(1, Number(quantity) || 1);
  return routine._resolveNpcBuyPlan(order?.itemCode, qty);
}

function enqueuePlanDeficitOrders(routine, plan, order, ctx, bankItems) {
  const bank = bankItems instanceof Map ? bankItems : new Map();

  for (const step of plan || []) {
    if (step.type === 'gather' && step.resource) {
      const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
      const deficit = step.quantity - have;
      if (deficit > 0) {
        routine._enqueueGatherOrderForDeficit(step, order, ctx, deficit);
      }
      continue;
    }

    if (step.type === 'fight' && step.monster) {
      const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
      const deficit = step.quantity - have;
      if (deficit > 0) {
        routine._enqueueFightOrderForDeficit(step, order, ctx, deficit);
      }
    }
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

  // Check npc_trade steps — ensure currency is obtainable
  for (const step of plan) {
    if (step.type !== 'npc_trade') continue;
    const currencyNeeded = step.quantity * step.buyPrice;
    const currencyHave = ctx.itemCount(step.currency) + (bankItems.get(step.currency) || 0);
    // If we don't have enough currency, check if the plan includes a gather/fight step for it
    if (currencyHave < currencyNeeded) {
      const currencySource = plan.find(s =>
        (s.type === 'gather' || s.type === 'fight') && s.itemCode === step.currency
      );
      if (!currencySource) {
        return { ok: false, reason: `missing_npc_currency:${step.currency}` };
      }
    }
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

export async function canClaimNpcBuyOrderNow(ctx, routine, order, bank, simCache) {
  const item = routine._getCraftClaimItem(order);
  if (!item) {
    return { ok: false, reason: 'invalid_npc_buy_order' };
  }

  const requiredLevel = Math.max(0, Number(order?.sourceLevel) || Number(item?.level) || 0);
  if ((Number(ctx.get()?.level) || 0) < requiredLevel) {
    return { ok: false, reason: 'insufficient_level' };
  }

  const plan = resolveNpcBuyPlanForOrder(routine, order);
  if (!plan || plan.length === 0) {
    return { ok: false, reason: 'unresolvable_npc_buy_plan' };
  }

  const finalStep = plan[plan.length - 1];
  if (finalStep?.type !== 'npc_trade' || !finalStep.npcCode || finalStep.itemCode !== order.itemCode) {
    return { ok: false, reason: 'invalid_npc_buy_plan', plan };
  }
  if (order?.sourceCode && finalStep.npcCode !== order.sourceCode) {
    return { ok: false, reason: 'wrong_npc_source', plan };
  }

  const bankItems = bank instanceof Map ? bank : new Map();
  const planCheck = routine._canFulfillCraftClaimPlanWithBank(plan, ctx, bankItems);
  if (!planCheck.ok) {
    return { ok: false, reason: 'insufficient_gather_skill', deficits: planCheck.deficits, plan };
  }

  for (const step of plan) {
    if (step.type !== 'bank') continue;
    const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
    if (have < step.quantity) {
      return { ok: false, reason: `missing_bank_dependency:${step.itemCode}`, plan };
    }
  }

  for (const step of plan) {
    if (step.type !== 'npc_trade') continue;
    const currencyNeeded = step.quantity * step.buyPrice;
    const currencyHave = currencyCountWithBank(ctx, bankItems, step.currency);
    if (currencyHave >= currencyNeeded) continue;

    const currencySource = plan.find((candidate) =>
      candidate !== step
      && candidate.itemCode === step.currency
      && (candidate.type === 'gather' || candidate.type === 'fight' || candidate.type === 'bank' || candidate.type === 'npc_trade')
    );
    if (!currencySource) {
      return { ok: false, reason: `missing_npc_currency:${step.currency}`, plan };
    }
  }

  for (const step of plan) {
    if (step.type !== 'fight') continue;

    const monsterCode = step.monster?.code;
    if (!monsterCode) {
      return { ok: false, reason: `invalid_fight_step:${step.itemCode || 'unknown'}`, plan };
    }
    if (step.monster?.type === 'boss') {
      return { ok: false, reason: `combat_not_viable:${monsterCode}`, plan };
    }

    const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
    if (have >= step.quantity) continue;

    if (!simCache.has(monsterCode)) {
      simCache.set(monsterCode, await routine._simulateClaimFight(ctx, monsterCode));
    }

    const sim = simCache.get(monsterCode);
    const simResult = sim?.simResult;
    if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
      return { ok: false, reason: `combat_not_viable:${monsterCode}`, plan };
    }
  }

  return { ok: true, reason: '', plan };
}

async function maybeResolveTaskRewardCraftDependency(ctx, routine, order, orderCraftSkill, viability, bank, simCache) {
  let nextViability = viability;
  let nextBank = bank;

  const missingCode = routine._parseMissingBankDependency(nextViability.reason);
  if (!missingCode || !routine._isTaskRewardCode(missingCode)) {
    return { viability: nextViability, bank: nextBank };
  }

  if (routine.orderBoard.createOrders) {
    // Order-first: post exchange order for cross-character fulfillment
    routine._enqueueTaskExchangeOrder(ctx, missingCode, 1);
    return { viability: nextViability, bank: nextBank };
  }

  // Legacy: try proactive self-exchange
  const proactive = await routine._maybeRunProactiveExchange(ctx, {
    extraNeedItemCode: missingCode,
    trigger: 'craft_claim',
  });
  if (proactive.attempted || proactive.resolved) {
    nextBank = await routine._getBankItems(true);
    nextViability = await routine._canClaimCraftOrderNow(ctx, order, orderCraftSkill, nextBank, simCache);
  }

  return { viability: nextViability, bank: nextBank };
}

function handleUnviableCraftOrder(routine, order, ctx, viability, bank) {
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

  // Queue gather/fight orders for NPC currency materials this character can't obtain
  if (viability.reason?.startsWith('missing_npc_currency:')) {
    const item = routine._getCraftClaimItem(order);
    const plan = item?.craft ? routine._resolveRecipeChain(item.craft) : null;
    if (plan) {
      const bankItems = bank instanceof Map ? bank : new Map();
      for (const step of plan) {
        if (step.type === 'gather' && step.resource) {
          const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
          const deficit = step.quantity - have;
          if (deficit > 0) {
            routine._enqueueGatherOrderForDeficit(step, order, ctx, deficit);
          }
        }
        if (step.type === 'fight' && step.monster) {
          const have = ctx.itemCount(step.itemCode) + (bankItems.get(step.itemCode) || 0);
          const deficit = step.quantity - have;
          if (deficit > 0) {
            routine._enqueueFightOrderForDeficit(step, order, ctx, deficit);
          }
        }
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
}

function handleUnviableNpcBuyOrder(routine, order, ctx, viability, bank) {
  const bankItems = bank instanceof Map ? bank : new Map();
  const plan = viability.plan || resolveNpcBuyPlanForOrder(routine, order);
  const blockTarget = order?.id ? order : routine._resolveOrderById(order?.orderId);

  if (viability.reason === 'insufficient_gather_skill' || viability.reason?.startsWith('missing_npc_currency:') || viability.reason?.startsWith('combat_not_viable:')) {
    enqueuePlanDeficitOrders(routine, plan, order, ctx, bankItems);
  }

  if (blockTarget) {
    routine._blockUnclaimableOrderForChar(blockTarget, ctx, viability.reason);
    return;
  }
}

function listCraftOrdersForClaim(ctx, craftSkill = '') {
  const skill = normalizeCraftSkill(craftSkill);
  return sortOrdersForClaim(listClaimableOrders({
    sourceType: 'craft',
    ...(skill ? { craftSkill: skill } : {}),
    charName: ctx.name,
  }));
}

function listNpcBuyOrdersForClaim(ctx) {
  return sortOrdersForClaim(listClaimableOrders({
    sourceType: 'npc_buy',
    charName: ctx.name,
  }));
}

async function tryClaimCraftOrder(ctx, routine, order, orderCraftSkill, bank, simCache, { allowSideEffects = true } = {}) {
  let viability = await routine._canClaimCraftOrderNow(ctx, order, orderCraftSkill, bank, simCache);
  let nextBank = bank;

  if (!viability.ok && allowSideEffects) {
    const taskRewardResult = await maybeResolveTaskRewardCraftDependency(
      ctx,
      routine,
      order,
      orderCraftSkill,
      viability,
      nextBank,
      simCache,
    );
    viability = taskRewardResult.viability;
    nextBank = taskRewardResult.bank;
  }

  if (!viability.ok) {
    return { claim: null, viability, bank: nextBank };
  }

  const active = routine._claimOrderForChar(ctx, order);
  return { claim: active, viability, bank: nextBank };
}

export async function acquireCraftOrderClaimAnySkill(
  ctx,
  routine,
  { craftSkill = '', expandLimit = Number.POSITIVE_INFINITY, directFirst = false } = {},
) {
  const orders = listCraftOrdersForClaim(ctx, craftSkill);
  if (orders.length === 0) return null;

  let bank = await routine._getBankItems();
  const simCache = new Map();
  const pending = [];

  for (const order of orders) {
    const orderCraftSkill = resolveCraftSkillForOrder(routine, order);
    if (!craftSkillMatches(orderCraftSkill, craftSkill)) continue;

    const claimAttempt = await tryClaimCraftOrder(
      ctx,
      routine,
      order,
      orderCraftSkill,
      bank,
      simCache,
      { allowSideEffects: !directFirst },
    );
    bank = claimAttempt.bank;
    if (claimAttempt.claim) return claimAttempt.claim;

    if (directFirst) {
      pending.push({ order, orderCraftSkill, viability: claimAttempt.viability });
      continue;
    }

    handleUnviableCraftOrder(routine, order, ctx, claimAttempt.viability, bank);
  }

  if (!directFirst) return null;

  let expanded = 0;
  for (const row of pending) {
    if (expanded >= expandLimit) break;

    const claimAttempt = await tryClaimCraftOrder(
      ctx,
      routine,
      row.order,
      row.orderCraftSkill,
      bank,
      simCache,
      { allowSideEffects: true },
    );
    bank = claimAttempt.bank;
    if (claimAttempt.claim) return claimAttempt.claim;

    handleUnviableCraftOrder(routine, row.order, ctx, claimAttempt.viability, bank);
    expanded += 1;
  }

  return null;
}

export async function acquireCraftOrderClaim(ctx, routine, craftSkill) {
  return acquireCraftOrderClaimAnySkill(ctx, routine, {
    craftSkill,
    expandLimit: Number.POSITIVE_INFINITY,
    directFirst: false,
  });
}

export async function acquireNpcBuyOrderClaim(ctx, routine) {
  const orders = listNpcBuyOrdersForClaim(ctx);
  if (orders.length === 0) return null;

  let bank = await routine._getBankItems();
  const simCache = new Map();

  for (const order of orders) {
    const viability = await routine._canClaimNpcBuyOrderNow(ctx, order, bank, simCache);
    if (!viability.ok) {
      handleUnviableNpcBuyOrder(routine, order, ctx, viability, bank);
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
  if (sourceType === 'npc_buy') {
    return routine._acquireNpcBuyOrderClaim(ctx);
  }
  if (sourceType === 'craft' && craftSkill) {
    return routine._acquireCraftOrderClaim(ctx, craftSkill);
  }
  if (sourceType === 'task_exchange') {
    return routine._acquireTaskExchangeOrderClaim(ctx);
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

export async function acquireTaskExchangeOrderClaim(ctx, routine) {
  const orders = sortOrdersForClaim(listClaimableOrders({
    sourceType: 'task_exchange',
    charName: ctx.name,
  }));
  if (orders.length === 0) return null;

  // Check coin availability before claiming
  const invCoins = ctx.itemCount(TASK_COIN_CODE);
  const bank = await routine._getBankItems();
  const bankCoins = bank.get(TASK_COIN_CODE) || 0;
  if (invCoins + bankCoins < TASK_EXCHANGE_COST) return null;

  for (const order of orders) {
    const active = routine._claimOrderForChar(ctx, order);
    if (active) return active;
  }
  return null;
}

export async function fulfillTaskExchangeOrderClaim(ctx, routine) {
  let claim = routine._syncActiveClaimFromBoard();
  if (!claim || claim.sourceType !== 'task_exchange') {
    return { attempted: false, fulfilled: false };
  }

  const itemCode = claim.itemCode;

  // Credit any existing bank items to this order before exchanging.
  // Items deposited before the order existed won't be credited via recordDeposits,
  // so we withdraw them and re-deposit to trigger the credit.
  const bankItems = await routine._getBankItems(true);
  const bankQty = bankItems.get(itemCode) || 0;
  const invQty = ctx.itemCount(itemCode);
  if (bankQty > 0 && claim.remainingQty > invQty) {
    const withdrawQty = Math.min(claim.remainingQty - invQty, bankQty);
    await withdrawBankItems(ctx, [{ code: itemCode, quantity: withdrawQty }], {
      reason: `exchange order credit: ${itemCode}`,
      mode: 'partial',
      retryStaleOnce: true,
    });
    const toDeposit = ctx.itemCount(itemCode);
    if (toDeposit > 0) {
      await depositBankItems(ctx, [{ code: itemCode, quantity: toDeposit }], {
        reason: `order claim ${claim.orderId}`,
      });
    }
    claim = routine._syncActiveClaimFromBoard();
    if (!claim) {
      log.info(`[${ctx.name}] Exchange order fulfilled (bank credit): ${itemCode}`);
      return { attempted: true, fulfilled: true };
    }
  }

  // Prefer a direct tasks_trader NPC purchase over random exchange when available.
  if (routine._canTasksTraderFulfill(itemCode)) {
    const result = await routine._runTasksTraderPurchase(ctx, {
      itemCode,
      remainingQty: claim.remainingQty,
    });

    const fresh = routine._syncActiveClaimFromBoard();
    if (!fresh) {
      log.info(`[${ctx.name}] Exchange order fulfilled via tasks_trader: ${itemCode}`);
      return { attempted: true, fulfilled: true };
    }

    if (result.reason === 'insufficient_coins') {
      await routine._blockAndReleaseClaim(ctx, 'insufficient_trader_coins');
      return { attempted: result.attempted, fulfilled: false, reason: 'insufficient_coins' };
    }

    if (result.reason === 'inventory_full') {
      await routine._clearActiveOrderClaim(ctx, { reason: 'trader_inventory_full' });
      return { attempted: result.attempted, fulfilled: false, reason: 'inventory_full' };
    }

    if (result.reason === 'condition_not_met') {
      await routine._blockAndReleaseClaim(ctx, 'trader_condition_not_met');
      return { attempted: result.attempted, fulfilled: false, reason: 'condition_not_met' };
    }

    return { attempted: result.attempted, fulfilled: false, reason: result.reason };
  }

  // Fallback: random task/exchange for items not sold by tasks_trader.
  const targetMap = new Map([[itemCode, claim.remainingQty]]);

  const result = await routine._runTaskExchange(ctx, {
    targets: targetMap,
    trigger: 'exchange_order',
    proactive: false,
  });

  const fresh = routine._syncActiveClaimFromBoard();
  if (!fresh) {
    log.info(`[${ctx.name}] Exchange order fulfilled: ${itemCode}`);
    return { attempted: true, fulfilled: true };
  }

  if (result.reason === 'insufficient_coins') {
    await routine._blockAndReleaseClaim(ctx, 'insufficient_exchange_coins');
    return { attempted: result.attempted, fulfilled: false, reason: 'insufficient_coins' };
  }

  if (result.reason === 'lock_busy' || result.reason === 'inventory_full') {
    await routine._clearActiveOrderClaim(ctx, { reason: `exchange_${result.reason}` });
    return { attempted: result.attempted, fulfilled: false, reason: result.reason };
  }

  return { attempted: result.attempted, fulfilled: false, reason: result.reason };
}

export async function fulfillNpcBuyOrderClaim(ctx, routine) {
  let claim = routine._syncActiveClaimFromBoard();
  if (!claim || claim.sourceType !== 'npc_buy') {
    return { attempted: false, fulfilled: false };
  }

  const itemCode = claim.itemCode;
  const bankItems = await routine._getBankItems(true);
  const bankQty = bankItems.get(itemCode) || 0;
  const invQty = ctx.itemCount(itemCode);
  if (bankQty > 0 && claim.remainingQty > invQty) {
    const withdrawQty = Math.min(claim.remainingQty - invQty, bankQty);
    await withdrawBankItems(ctx, [{ code: itemCode, quantity: withdrawQty }], {
      reason: `npc_buy order credit: ${itemCode}`,
      mode: 'partial',
      retryStaleOnce: true,
    });
    const toDeposit = ctx.itemCount(itemCode);
    if (toDeposit > 0) {
      await depositBankItems(ctx, [{ code: itemCode, quantity: toDeposit }], {
        reason: `order claim ${claim.orderId}`,
      });
    }
    claim = routine._syncActiveClaimFromBoard();
    if (!claim) {
      log.info(`[${ctx.name}] NPC-buy order fulfilled (bank credit): ${itemCode}`);
      return { attempted: true, fulfilled: true };
    }
  }

  const simCache = new Map();
  const viability = await routine._canClaimNpcBuyOrderNow(ctx, claim, await routine._getBankItems(true), simCache);
  if (!viability.ok) {
    handleUnviableNpcBuyOrder(routine, claim, ctx, viability, await routine._getBankItems(true));
    return { attempted: false, fulfilled: false, reason: viability.reason };
  }

  const plan = viability.plan || resolveNpcBuyPlanForOrder(routine, claim, claim.remainingQty);
  const withdrawn = await withdrawPlanFromBank(ctx, plan, 1, {
    excludeCodes: [claim.itemCode],
  });
  if (withdrawn.length > 0) {
    log.info(`[${ctx.name}] NPC-buy order: withdrew from bank: ${withdrawn.join(', ')}`);
    return { attempted: true, fulfilled: false, reason: 'withdrew_dependencies' };
  }

  for (const step of plan) {
    if (step.type === 'bank') {
      const need = step.quantity - ctx.itemCount(step.itemCode);
      if (need <= 0) continue;

      await withdrawBankItems(ctx, [{ code: step.itemCode, quantity: need }], {
        reason: `npc_buy dependency ${step.itemCode}`,
        mode: 'partial',
        retryStaleOnce: true,
      });
      return { attempted: true, fulfilled: false, reason: 'withdrew_bank_dependency' };
    }

    if (step.type === 'gather') {
      if (ctx.itemCount(step.itemCode) >= step.quantity) continue;

      const loc = await gameData.getResourceLocation(step.resource.code);
      if (!loc) {
        await routine._blockAndReleaseClaim(ctx, 'missing_gather_location');
        return { attempted: false, fulfilled: false, reason: 'missing_gather_location' };
      }

      await equipForGathering(ctx, step.resource.skill);
      try {
        await moveTo(ctx, loc.x, loc.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          gameData.markLocationUnreachable('resource', step.resource.code);
          await routine._blockAndReleaseClaim(ctx, 'missing_gather_location');
          return { attempted: false, fulfilled: false, reason: 'missing_gather_location' };
        }
        throw err;
      }
      const result = await gatherOnce(ctx);
      const items = result.details?.items || [];
      log.info(`[${ctx.name}] NPC-buy order gather ${step.itemCode}: ${items.map(row => `${row.code}x${row.quantity}`).join(', ') || 'nothing'}`);
      return { attempted: true, fulfilled: false };
    }

    if (step.type === 'fight') {
      if (ctx.itemCount(step.itemCode) >= step.quantity) continue;

      const monsterCode = step.monster.code;
      const monsterLoc = await gameData.getMonsterLocation(monsterCode);
      if (!monsterLoc) {
        await routine._blockAndReleaseClaim(ctx, 'missing_fight_location');
        return { attempted: false, fulfilled: false, reason: 'missing_fight_location' };
      }

      const { simResult, ready = true } = await routine._equipForCraftFight(ctx, monsterCode);
      if (!ready || !simResult || !simResult.win || simResult.hpLostPercent > 90) {
        enqueuePlanDeficitOrders(routine, plan, claim, ctx, await routine._getBankItems(true));
        await routine._blockAndReleaseClaim(ctx, `combat_not_viable:${monsterCode}`);
        return { attempted: false, fulfilled: false, reason: `combat_not_viable:${monsterCode}` };
      }

      await prepareCombatPotions(ctx, monsterCode);
      if (!(await restBeforeFight(ctx, monsterCode))) {
        const minHp = hpNeededForFight(ctx, monsterCode);
        if (minHp === null) {
          enqueuePlanDeficitOrders(routine, plan, claim, ctx, await routine._getBankItems(true));
          await routine._blockAndReleaseClaim(ctx, `combat_not_viable:${monsterCode}`);
          return { attempted: false, fulfilled: false, reason: `combat_not_viable:${monsterCode}` };
        }
        return { attempted: false, fulfilled: false, reason: 'waiting_for_rest' };
      }

      try {
        await moveTo(ctx, monsterLoc.x, monsterLoc.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          gameData.markLocationUnreachable('monster', monsterCode);
          await routine._blockAndReleaseClaim(ctx, 'missing_fight_location');
          return { attempted: false, fulfilled: false, reason: 'missing_fight_location' };
        }
        throw err;
      }

      const result = await fightOnce(ctx);
      const fight = parseFightResult(result, ctx);
      if (fight.win) {
        ctx.clearLosses(monsterCode);
        log.info(`[${ctx.name}] NPC-buy order fight ${monsterCode}: WIN ${fight.turns}t${fight.drops ? ' | ' + fight.drops : ''}`);
      } else {
        ctx.recordLoss(monsterCode);
        const losses = ctx.consecutiveLosses(monsterCode);
        log.warn(`[${ctx.name}] NPC-buy order fight ${monsterCode}: LOSS (${losses} losses)`);
        if (losses >= routine.maxLosses) {
          enqueuePlanDeficitOrders(routine, plan, claim, ctx, await routine._getBankItems(true));
          await routine._blockAndReleaseClaim(ctx, 'combat_losses');
        }
      }
      return { attempted: true, fulfilled: false };
    }

    if (step.type === 'npc_trade') {
      const needQty = step.quantity - ctx.itemCount(step.itemCode);
      if (needQty <= 0) continue;

      const currencyNeeded = needQty * step.buyPrice;
      const topUp = await topUpNpcCurrency(ctx, step.currency, currencyNeeded, {
        reason: `npc_buy claim ${claim.itemCode}`,
      });
      if (topUp.error) {
        log.warn(`[${ctx.name}] NPC-buy order: failed to top up ${step.currency} for ${step.itemCode}: ${topUp.error.message}`);
      }
      if (carriedCurrencyCount(ctx, step.currency) < currencyNeeded) {
        handleUnviableNpcBuyOrder(routine, claim, ctx, {
          ok: false,
          reason: `missing_npc_currency:${step.currency}`,
          plan,
        }, await routine._getBankItems(true));
        return { attempted: topUp.attempted, fulfilled: false, reason: `missing_npc_currency:${step.currency}` };
      }

      const purchase = await buyItemFromNpc(ctx, {
        npcCode: step.npcCode,
        itemCode: step.itemCode,
        quantity: needQty,
      });
      if (!purchase.ok && purchase.reason === 'npc_not_found') {
        await routine._blockAndReleaseClaim(ctx, `npc_inaccessible:${step.npcCode}`);
        return { attempted: false, fulfilled: false, reason: 'npc_not_found' };
      }
      if (!purchase.ok && purchase.reason === 'condition_not_met') {
        await routine._blockAndReleaseClaim(ctx, `npc_inaccessible:${step.npcCode}`);
        return { attempted: false, fulfilled: false, reason: 'condition_not_met' };
      }
      if (!purchase.ok) {
        return { attempted: purchase.attempted, fulfilled: false, reason: purchase.reason };
      }

      log.info(`[${ctx.name}] NPC-buy order: bought ${step.itemCode} x${needQty} from ${step.npcCode}`);
      const deposited = await routine._depositClaimItemsIfNeeded(ctx, { force: step.itemCode === claim.itemCode });
      const fresh = routine._syncActiveClaimFromBoard();
      if (step.itemCode === claim.itemCode && (!fresh || deposited)) {
        if (!fresh) {
          log.info(`[${ctx.name}] NPC-buy order fulfilled: ${claim.itemCode}`);
          return { attempted: true, fulfilled: true };
        }
      }
      return { attempted: true, fulfilled: false };
    }
  }

  const deposited = await routine._depositClaimItemsIfNeeded(ctx, { force: true });
  const fresh = routine._syncActiveClaimFromBoard();
  return { attempted: deposited, fulfilled: !fresh };
}

export function enqueueTaskExchangeOrder(routine, ctx, itemCode, deficit) {
  if (!routine.rotation) return;
  const qty = Math.max(1, Math.floor(Number(deficit) || 0));
  try {
    routine.rotation._enqueueOrder({
      requesterName: ctx.name,
      itemCode,
      sourceType: 'task_exchange',
      sourceCode: itemCode,
      quantity: qty,
    });
    log.info(`[${ctx.name}] Queued task_exchange order for ${itemCode} x${qty}`);
  } catch (err) {
    log.warn(`[${ctx.name}] Could not queue task_exchange order for ${itemCode}: ${err?.message || String(err)}`);
  }
}
