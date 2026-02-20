/**
 * Item task executor — accept, gather/craft/trade item tasks.
 *
 * All cross-calls go through routine._* wrappers so tests can monkey-patch methods.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, gatherOnce, equipForGathering } from '../../helpers.mjs';
import { withdrawBankItems } from '../../services/bank-ops.mjs';
import { TASKS_MASTER } from '../../data/locations.mjs';

export async function runItemTaskFlow(ctx, routine) {
  const ITEMS_MASTER = TASKS_MASTER.items;

  // 1. Accept a task if we don't have one
  if (!ctx.hasTask()) {
    await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
    const result = await api.acceptTask(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    const c = ctx.get();
    log.info(`[${ctx.name}] Item Task: accepted ${c.task} x${c.task_total}`);
  }

  // 2. Complete task if done
  if (ctx.taskComplete()) {
    await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
    const result = await api.completeTask(ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    routine.rotation.recordProgress(1);
    log.info(`[${ctx.name}] Item Task: completed! (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
    await routine._exchangeTaskCoins(ctx);
    return true;
  }

  const c = ctx.get();
  const itemCode = c.task;
  const needed = c.task_total - c.task_progress;

  // 3. Check prerequisites — can we obtain this item?
  const item = routine._getItemTaskItem(itemCode);
  if (!item) {
    log.warn(`[${ctx.name}] Item Task: unknown item ${itemCode}, cancelling`);
    await routine._cancelItemTask(ctx, ITEMS_MASTER);
    return true;
  }

  // Check if it's a gatherable resource drop
  const resource = routine._getItemTaskResource(itemCode);
  // Check if it's craftable
  const craftable = item.craft ? true : false;
  const charGatherLevel = resource ? ctx.skillLevel(resource.skill) : 0;
  const canGatherNow = !!resource && charGatherLevel >= resource.level;

  if (!resource && !craftable) {
    log.warn(`[${ctx.name}] Item Task: ${itemCode} can't be gathered or crafted, cancelling`);
    await routine._cancelItemTask(ctx, ITEMS_MASTER);
    return true;
  }

  // Try to withdraw from bank and trade first (before gathering)
  const haveQty = ctx.itemCount(itemCode);
  if (!ctx.inventoryFull()) {
    const withdrawn = await routine._withdrawForItemTask(ctx, itemCode, needed - haveQty);
    const totalHave = ctx.itemCount(itemCode);
    if (withdrawn > 0) {
      const tradeQty = Math.min(Math.max(totalHave, withdrawn), needed);
      if (tradeQty > 0) {
        return routine._tradeItemTask(ctx, itemCode, tradeQty);
      }
    }

    const shouldTradeAfterBank = routine._shouldTradeItemTaskNow(ctx, {
      haveQty: totalHave,
      needed,
      canGatherNow,
      usableSpace: routine._usableInventorySpace(ctx),
    });
    if (shouldTradeAfterBank.tradeNow) {
      return routine._tradeItemTask(ctx, itemCode, Math.min(totalHave, needed));
    }
  }

  // If we have accumulated enough inventory for this item task, trade now.
  const currentHave = ctx.itemCount(itemCode);
  const shouldTrade = routine._shouldTradeItemTaskNow(ctx, {
    haveQty: currentHave,
    needed,
    canGatherNow,
    usableSpace: routine._usableInventorySpace(ctx),
  });
  if (shouldTrade.tradeNow) {
    return routine._tradeItemTask(ctx, itemCode, Math.min(currentHave, needed));
  }

  // Prerequisite check for gathering
  if (resource) {
    if (!canGatherNow) {
      // Can we craft it instead?
      if (!craftable) {
        log.warn(`[${ctx.name}] Item Task: need ${resource.skill} lv${resource.level} for ${itemCode} (have lv${charGatherLevel}), cancelling`);
        await routine._cancelItemTask(ctx, ITEMS_MASTER);
        return true;
      }
      // Fall through to crafting path
    } else {
      // Gather path
      return routine._gatherForItemTask(ctx, itemCode, resource, needed);
    }
  }

  // Crafting path
  if (craftable) {
    const plan = routine._resolveRecipeChain(item.craft);
    if (!plan) {
      log.warn(`[${ctx.name}] Item Task: can't resolve recipe for ${itemCode}, cancelling`);
      await routine._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
      return true;
    }

    // Check if character can execute all steps
    let canExecute = true;
    for (const step of plan) {
      if (step.type === 'gather' && step.resource) {
        if (ctx.skillLevel(step.resource.skill) < step.resource.level) {
          log.warn(`[${ctx.name}] Item Task: ${itemCode} needs ${step.resource.skill} lv${step.resource.level} (have lv${ctx.skillLevel(step.resource.skill)})`);
          canExecute = false;
          break;
        }
      }
      if (step.type === 'craft' && step.recipe) {
        if (ctx.skillLevel(step.recipe.skill) < step.recipe.level) {
          log.warn(`[${ctx.name}] Item Task: ${itemCode} needs ${step.recipe.skill} lv${step.recipe.level} for crafting (have lv${ctx.skillLevel(step.recipe.skill)})`);
          canExecute = false;
          break;
        }
      }
    }

    if (!canExecute) {
      await routine._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
      return true;
    }

    // Check craft skill level for the final item itself
    if (ctx.skillLevel(item.craft.skill) < item.craft.level) {
      log.warn(`[${ctx.name}] Item Task: need ${item.craft.skill} lv${item.craft.level} to craft ${itemCode} (have lv${ctx.skillLevel(item.craft.skill)})`);
      await routine._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
      return true;
    }

    return routine._craftForItemTask(ctx, itemCode, item, plan, needed);
  }

  // Fallback gather
  if (resource) {
    return routine._gatherForItemTask(ctx, itemCode, resource, needed);
  }

  // Can't obtain this item — place order and cancel
  log.warn(`[${ctx.name}] Item Task: no path to obtain ${itemCode}`);
  await routine._placeOrderAndCancel(ctx, itemCode, needed, ITEMS_MASTER);
  return true;
}

export async function craftForItemTask(ctx, routine, itemCode, item, plan, needed) {
  // How many of the final item do we need to craft?
  // Each craft produces item.craft.quantity units
  const craftYield = item.craft.quantity || 1;
  const haveItem = ctx.itemCount(itemCode);
  const roundsRemaining = Math.ceil((needed - haveItem) / craftYield);
  if (roundsRemaining <= 0) {
    // Already have enough — trade them
    return routine._tradeItemTask(ctx, itemCode, Math.min(haveItem, needed));
  }

  let materialsPerRound = 0;
  for (const step of plan) {
    if (step.type !== 'craft') {
      materialsPerRound += Math.max(0, Number(step.quantity) || 0);
    }
  }
  if (materialsPerRound <= 0) materialsPerRound = 1;

  const usable = routine._usableInventorySpace(ctx);
  const spaceLimit = Math.floor(usable / materialsPerRound);
  const batchRounds = Math.max(1, Math.min(roundsRemaining, spaceLimit));
  if (batchRounds < roundsRemaining) {
    log.info(
      `[${ctx.name}] Item Task craft: batching ${itemCode} to ${batchRounds}/${roundsRemaining} ` +
      `round(s) (usable space ${usable}, mats/round ${materialsPerRound})`,
    );
  }

  // Process each step in the recipe chain
  for (const step of plan) {
    const stepNeeded = step.quantity * batchRounds;
    const stepHave = ctx.itemCount(step.itemCode);

    if (stepHave >= stepNeeded) continue; // already have enough

    const deficit = stepNeeded - stepHave;

    if (step.type === 'gather') {
      // Try bank first
      if (!ctx.inventoryFull()) {
        await routine._withdrawForItemTask(ctx, step.itemCode, deficit, { maxQuantity: deficit });
        if (ctx.itemCount(step.itemCode) >= stepNeeded) continue;
      }

      const usableNow = routine._usableInventorySpace(ctx);
      if (usableNow <= 0) {
        const reserve = routine._inventoryReserve(ctx);
        log.info(
          `[${ctx.name}] Item Task craft: reserve pressure before gathering ${step.itemCode} ` +
          `(${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve}) — craft/trade fallback`,
        );
        const fallback = await routine._craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed, {
          reason: `reserve pressure while gathering ${step.itemCode}`,
        });
        if (fallback.progressed) return true;
        log.info(`[${ctx.name}] Item Task craft: reserve pressure and no craft/trade progress, yielding`);
        return false;
      }

      // Gather the rest
      const loc = await gameData.getResourceLocation(step.resource.code);
      if (!loc) {
        log.warn(`[${ctx.name}] Item Task craft: can't find location for ${step.resource.code}`);
        return true;
      }

      await equipForGathering(ctx, step.resource.skill);
      await moveTo(ctx, loc.x, loc.y);
      const result = await gatherOnce(ctx);
      const items = result.details?.items || [];
      log.info(`[${ctx.name}] Item Task craft: gathering ${step.itemCode} for ${itemCode} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${ctx.itemCount(step.itemCode)}/${stepNeeded})`);
      // Return to let the loop call us again — we'll accumulate materials over multiple ticks
      return true;
    }

    if (step.type === 'craft') {
      // Check if we have the materials for this intermediate craft
      const craftItem = gameData.getItem(step.itemCode);
      if (!craftItem?.craft) continue;

      const canCraft = Math.min(
        ...craftItem.craft.items.map(mat =>
          Math.floor(ctx.itemCount(mat.code) / mat.quantity)
        )
      );
      if (canCraft <= 0) continue; // need to gather more, earlier steps will handle it

      const toCraft = Math.min(canCraft, Math.ceil(deficit / (craftItem.craft.quantity || 1)));
      const workshops = await gameData.getWorkshops();
      const ws = workshops[craftItem.craft.skill];
      if (!ws) {
        log.warn(`[${ctx.name}] Item Task craft: no workshop for ${craftItem.craft.skill}`);
        return true;
      }

      await moveTo(ctx, ws.x, ws.y);
      const result = await api.craft(step.itemCode, toCraft, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
      log.info(`[${ctx.name}] Item Task craft: crafted ${step.itemCode} x${toCraft} (${ctx.itemCount(step.itemCode)}/${stepNeeded})`);
      return true;
    }

    if (step.type === 'fight') {
      // Need to fight a monster for a drop — skip for now if we can't
      log.warn(`[${ctx.name}] Item Task craft: need ${step.itemCode} from ${step.monster?.code || 'unknown'} — fight drops not yet supported in item tasks`);
      return true;
    }
  }

  const finalPass = await routine._craftAndTradeItemTaskFromInventory(ctx, itemCode, item, needed);
  if (finalPass.progressed) return true;

  // Shouldn't happen if steps above ran correctly, but safety check
  log.warn(`[${ctx.name}] Item Task craft: have all steps but can't craft ${itemCode}?`);
  return true;
}

export async function craftAndTradeItemTaskFromInventory(ctx, routine, itemCode, item, needed, opts = {}) {
  if (!item?.craft) return { progressed: false, crafted: false, traded: false };

  let crafted = false;
  let traded = false;
  const craftYield = item.craft.quantity || 1;
  const recipeItems = Array.isArray(item.craft.items) ? item.craft.items : [];

  if (recipeItems.length > 0) {
    const canCraftFinal = Math.min(
      ...recipeItems.map(mat =>
        Math.floor(ctx.itemCount(mat.code) / mat.quantity)
      )
    );

    if (canCraftFinal > 0) {
      const currentHave = ctx.itemCount(itemCode);
      const remainingNeeded = Math.max(0, needed - currentHave);
      let toCraft = canCraftFinal;
      if (remainingNeeded > 0) {
        toCraft = Math.min(toCraft, Math.ceil(remainingNeeded / craftYield));
      }

      if (toCraft > 0) {
        const workshops = await gameData.getWorkshops();
        const ws = workshops[item.craft.skill];
        if (!ws) {
          log.warn(`[${ctx.name}] Item Task craft: no workshop for ${item.craft.skill}`);
          return { progressed: false, crafted: false, traded: false };
        }

        await moveTo(ctx, ws.x, ws.y);
        const result = await api.craft(itemCode, toCraft, ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();
        const produced = toCraft * craftYield;
        log.info(`[${ctx.name}] Item Task craft: crafted ${itemCode} x${produced}${opts.reason ? ` (${opts.reason})` : ''}`);
        crafted = true;
      }
    }
  }

  const tradeQty = Math.min(ctx.itemCount(itemCode), needed);
  if (tradeQty > 0) {
    if (opts.reason) {
      log.info(`[${ctx.name}] Item Task craft: ${opts.reason} — trading ${itemCode} x${tradeQty}`);
    }
    await routine._tradeItemTask(ctx, itemCode, tradeQty);
    traded = true;
  }

  return {
    progressed: crafted || traded,
    crafted,
    traded,
  };
}

export async function placeOrderAndCancel(ctx, routine, itemCode, needed, masterLoc) {
  // Try to place an order on the orderboard
  const item = gameData.getItem(itemCode);
  const resource = gameData.getResourceForDrop(itemCode);

  if (resource) {
    routine.rotation._enqueueOrder({
      sourceType: 'gather',
      sourceCode: resource.code,
      gatherSkill: resource.skill,
      sourceLevel: resource.level,
      itemCode,
      requesterName: ctx.name,
      quantity: needed,
    });
    log.info(`[${ctx.name}] Item Task: placed orderboard request for ${itemCode} x${needed} (gather ${resource.code})`);
  } else if (item?.craft) {
    // For crafted items, place order for the raw materials
    const plan = gameData.resolveRecipeChain(item.craft);
    if (plan) {
      for (const step of plan) {
        if (step.type === 'gather' && step.resource) {
          routine.rotation._enqueueOrder({
            sourceType: 'gather',
            sourceCode: step.resource.code,
            gatherSkill: step.resource.skill,
            sourceLevel: step.resource.level,
            itemCode: step.itemCode,
            requesterName: ctx.name,
            recipeCode: itemCode,
            quantity: step.quantity * needed,
          });
          log.info(`[${ctx.name}] Item Task: placed orderboard request for ${step.itemCode} x${step.quantity * needed} (for ${itemCode})`);
        }
      }
    }
  }

  await routine._cancelItemTask(ctx, masterLoc);
}

export async function cancelItemTask(ctx, routine, masterLoc) {
  if (ctx.taskCoins() < 1) {
    log.warn(`[${ctx.name}] Item Task: can't cancel (no task coins), force-rotating`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return;
  }
  await moveTo(ctx, masterLoc.x, masterLoc.y);
  const result = await api.cancelTask(ctx.name);
  await api.waitForCooldown(result);
  await ctx.refresh();
  log.info(`[${ctx.name}] Item Task: cancelled`);
}

export async function withdrawForItemTask(ctx, routine, itemCode, needed, opts = {}) {
  const neededQty = Math.max(0, Math.floor(Number(needed) || 0));
  if (neededQty <= 0) return 0;

  const bank = await gameData.getBankItems(true);
  const inBank = bank.get(itemCode) || 0;
  log.info(`[${ctx.name}] Item Task: bank check for ${itemCode} — ${inBank} in bank, need ${neededQty}`);
  if (inBank <= 0) return 0;

  const rawMaxQuantity = Number(opts.maxQuantity);
  const maxQuantity = Number.isFinite(rawMaxQuantity)
    ? Math.max(0, Math.floor(rawMaxQuantity))
    : Number.POSITIVE_INFINITY;
  const usable = routine._usableInventorySpace(ctx);
  const toWithdraw = Math.min(inBank, neededQty, usable, maxQuantity);
  if (toWithdraw <= 0) {
    if (usable <= 0) {
      const reserve = routine._inventoryReserve(ctx);
      log.info(
        `[${ctx.name}] Item Task: withdrawal deferred for ${itemCode}; ` +
        `reserve reached (${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve})`,
      );
    }
    return 0;
  }

  try {
    const result = await withdrawBankItems(ctx, [{ code: itemCode, quantity: toWithdraw }], {
      reason: 'item task withdrawal',
      mode: 'partial',
      retryStaleOnce: true,
    });
    const row = result.withdrawn.find(entry => entry.code === itemCode);
    const withdrawn = row?.quantity || 0;
    if (withdrawn > 0) {
      log.info(`[${ctx.name}] Item Task: withdrew ${itemCode} x${withdrawn} from bank`);
    }
    return withdrawn;
  } catch (err) {
    log.warn(`[${ctx.name}] Item Task: bank withdraw failed for ${itemCode}: ${err.message}`);
    return 0;
  }
}

export function shouldTradeItemTaskNow(ctx, { haveQty = 0, needed = 0, canGatherNow = false, usableSpace = Infinity } = {}) {
  const qty = Math.max(0, Math.floor(Number(haveQty) || 0));
  const remaining = Math.max(0, Math.floor(Number(needed) || 0));
  const space = Math.max(0, Math.floor(Number(usableSpace)) || 0);
  const batchTarget = Math.max(1, Math.min(remaining, qty + space));

  if (qty <= 0) return { tradeNow: false, batchTarget };
  if (canGatherNow === false) return { tradeNow: true, batchTarget };
  if (ctx.inventoryFull()) return { tradeNow: true, batchTarget };
  if (qty >= batchTarget) return { tradeNow: true, batchTarget };

  return { tradeNow: false, batchTarget };
}

export async function gatherForItemTask(ctx, routine, itemCode, resource, needed) {
  const loc = await gameData.getResourceLocation(resource.code);
  if (!loc) {
    log.warn(`[${ctx.name}] Item Task: can't find location for ${resource.code}`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return true;
  }

  // Trade if we've filled available inventory space
  const haveQty = ctx.itemCount(itemCode);
  const decision = routine._shouldTradeItemTaskNow(ctx, {
    haveQty,
    needed,
    canGatherNow: true,
    usableSpace: routine._usableInventorySpace(ctx),
  });
  if (decision.tradeNow) {
    return routine._tradeItemTask(ctx, itemCode, Math.min(haveQty, needed));
  }

  // If inventory is full but no task items, can't continue
  if (ctx.inventoryFull()) return false;

  // Gather
  await equipForGathering(ctx, resource.skill);
  await moveTo(ctx, loc.x, loc.y);
  const result = await gatherOnce(ctx);
  const items = result.details?.items || [];
  log.info(`[${ctx.name}] Item Task: gathering ${itemCode} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${ctx.itemCount(itemCode)}/${decision.batchTarget} for next trade)`);

  return !ctx.inventoryFull();
}

export async function tradeItemTask(ctx, itemCode, quantity) {
  const ITEMS_MASTER = TASKS_MASTER.items;
  await moveTo(ctx, ITEMS_MASTER.x, ITEMS_MASTER.y);
  try {
    const result = await api.taskTrade(itemCode, quantity, ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();
    const c = ctx.get();
    log.info(`[${ctx.name}] Item Task: traded ${itemCode} x${quantity} (${c.task_progress}/${c.task_total})`);
  } catch (err) {
    if (err.code === 478) {
      log.warn(`[${ctx.name}] Item Task: missing items for trade`);
    } else {
      throw err;
    }
  }
  return true;
}
