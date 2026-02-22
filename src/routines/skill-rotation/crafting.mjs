/**
 * Crafting executor — multi-step recipe crafting with bank withdrawals,
 * intermediate gathering, combat drops, and batch management.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, gatherOnce, fightOnce, parseFightResult, withdrawPlanFromBank, rawMaterialNeeded } from '../../helpers.mjs';
import { restBeforeFight } from '../../services/food-manager.mjs';
import { hpNeededForFight } from '../../services/combat-simulator.mjs';
import { equipForCombat, equipForGathering } from '../../services/gear-loadout.mjs';
import { depositBankItems } from '../../services/bank-ops.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';
import { RESERVE_PCT, RESERVE_MIN, RESERVE_MAX } from './constants.mjs';

export async function executeCrafting(ctx, routine) {
  const craftSkill = routine.rotation.currentSkill;
  const claim = await routine._ensureOrderClaim(ctx, 'craft', { craftSkill });

  let recipe = routine.rotation.recipe;
  let plan = routine.rotation.productionPlan;
  let claimMode = false;
  let claimGoal = 0;

  if (claim) {
    const claimItem = routine._getCraftClaimItem(claim);
    if (!claimItem?.craft?.skill) {
      await routine._blockAndReleaseClaim(ctx, 'invalid_craft_order');
      return true;
    }
    if (claimItem.craft.skill !== craftSkill) {
      await routine._blockAndReleaseClaim(ctx, 'wrong_craft_skill');
      return true;
    }
    if (ctx.skillLevel(craftSkill) < claimItem.craft.level) {
      await routine._blockAndReleaseClaim(ctx, 'insufficient_craft_level');
      return true;
    }

    const claimPlan = routine._resolveRecipeChain(claimItem.craft);
    if (!claimPlan) {
      await routine._blockAndReleaseClaim(ctx, 'unresolvable_recipe_chain');
      return true;
    }

    recipe = claimItem;
    plan = claimPlan;
    claimMode = true;
    claimGoal = Math.max(1, Number(claim.remainingQty) || 1);
  }

  if (!plan || !recipe) {
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Work on a local copy so claim-mode planning doesn't mutate rotation state.
  plan = [...plan];

  // Append final craft step if not already in the plan.
  if (plan.length === 0 || plan[plan.length - 1].itemCode !== recipe.code) {
    plan.push({ type: 'craft', itemCode: recipe.code, recipe: recipe.craft, quantity: 1 });
  }

  // Re-withdraw if bank routine deposited our materials
  if (routine.rotation.bankChecked && ctx.inventoryCount() === 0) {
    routine.rotation.bankChecked = false;
  }

  // Withdraw matching ingredients from bank (scaled for batch)
  if (!routine.rotation.bankChecked) {
    routine.rotation.bankChecked = true;
    routine._currentBatch = claimMode ? 1 : routine._batchSize(ctx);
    await routine._withdrawFromBank(ctx, plan, recipe.code, routine._currentBatch);
  }

  // Walk through production plan steps
  let reserveGatherBlocked = false;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];

    if (step.type === 'bank') {
      // Must come from bank (event items, etc.) — already withdrawn above
      const have = ctx.itemCount(step.itemCode);
      if (have >= step.quantity) continue; // have enough for at least 1 craft
      if (routine._isTaskRewardCode(step.itemCode)) {
        const proactive = await routine._maybeRunProactiveExchange(ctx, {
          extraNeedItemCode: step.itemCode,
          trigger: claimMode ? 'craft_step_claim' : 'craft_step',
        });
        if (proactive.resolved) {
          // Rewards are deposited to bank; force a fresh withdraw pass next tick.
          routine.rotation.bankChecked = false;
          return true;
        }
      }
      if (claimMode) {
        await routine._blockAndReleaseClaim(ctx, 'missing_bank_dependency');
      } else {
        log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: need ${step.quantity}x ${step.itemCode} from bank, have ${have} — skipping recipe`);
        await routine.rotation.forceRotate(ctx);
      }
      return true;
    }

    if (step.type === 'gather') {
      // Check if we already have enough (accounting for batch + intermediates)
      const needed = rawMaterialNeeded(ctx, plan, step.itemCode, routine._currentBatch);
      if (ctx.itemCount(step.itemCode) >= needed) continue;

      const usableSpace = routine._usableInventorySpace(ctx);
      if (usableSpace <= 0) {
        const reserve = routine._inventoryReserve(ctx);
        log.info(
          `[${ctx.name}] ${routine.rotation.currentSkill}: gather paused for ${step.itemCode}; ` +
          `inventory reserve reached (${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, reserve ${reserve})`,
        );
        reserveGatherBlocked = true;
        continue;
      }

      // Gather one batch from the resource
      const loc = await gameData.getResourceLocation(step.resource.code);
      if (!loc) {
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, 'missing_gather_location');
        } else {
          log.warn(`[${ctx.name}] Cannot find location for ${step.resource.code}, skipping recipe`);
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }

      // Equip gathering gear for this resource's skill (e.g. alchemy gloves)
      await equipForGathering(ctx, step.resource.skill);

      await moveTo(ctx, loc.x, loc.y);
      const result = await gatherOnce(ctx);
      const items = result.details?.items || [];
      log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: gathering ${step.itemCode} for ${recipe.code} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);
      return !ctx.inventoryFull();
    }

    if (step.type === 'fight') {
      // Check if we already have enough from bank withdrawal or prior fights
      const needed = step.quantity * routine._currentBatch;
      if (ctx.itemCount(step.itemCode) >= needed) continue;

      // Find monster location
      const monsterCode = step.monster.code;
      const monsterLoc = step.monsterLoc || await gameData.getMonsterLocation(monsterCode);
      if (!monsterLoc) {
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, 'missing_fight_location');
        } else {
          log.warn(`[${ctx.name}] Cannot find location for monster ${monsterCode}, skipping recipe`);
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }

      // Equip for combat against this monster
      const { simResult, ready = true } = await routine._equipForCraftFight(ctx, monsterCode);
      if (!ready) {
        if (claimMode) {
          log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: combat gear not ready for ${monsterCode}, blocking claim`);
          await routine._blockAndReleaseClaim(ctx, `combat_gear_not_ready:${monsterCode}`);
          return true;
        }
        log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: combat gear not ready for ${monsterCode}, blocking recipe and rotating`);
        routine.rotation.blockCurrentRecipe({
          reason: `combat gear not ready vs ${monsterCode}`,
          ctx,
        });
        await routine.rotation.forceRotate(ctx);
        return true;
      }
      if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
        await routine._handleUnwinnableCraftFight(ctx, {
          monsterCode,
          itemCode: step.itemCode,
          recipeCode: recipe.code,
          claimMode,
          simResult,
        });
        return true;
      }

      await prepareCombatPotions(ctx, monsterCode);

      if (!(await restBeforeFight(ctx, monsterCode))) {
        const minHp = hpNeededForFight(ctx, monsterCode);
        if (minHp === null) {
          log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: ${monsterCode} unbeatable for ${step.itemCode}, rotating`);
          await routine.rotation.forceRotate(ctx);
          return true;
        }
        log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: insufficient HP for ${monsterCode}, yielding for rest`);
        return true;
      }

      await moveTo(ctx, monsterLoc.x, monsterLoc.y);
      const result = await fightOnce(ctx);
      const r = parseFightResult(result, ctx);

      if (r.win) {
        ctx.clearLosses(monsterCode);
        log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: farming ${step.itemCode} from ${monsterCode} for ${recipe.code} — WIN ${r.turns}t${r.drops ? ' | ' + r.drops : ''} (have ${ctx.itemCount(step.itemCode)}/${needed})`);
      } else {
        ctx.recordLoss(monsterCode);
        const losses = ctx.consecutiveLosses(monsterCode);
        log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: farming ${monsterCode} for ${step.itemCode} — LOSS (${losses} losses)`);
        if (losses >= routine.maxLosses) {
          if (claimMode) {
            await routine._blockAndReleaseClaim(ctx, 'combat_losses');
          } else {
            log.info(`[${ctx.name}] Too many losses farming ${monsterCode}, rotating`);
            await routine.rotation.forceRotate(ctx);
          }
        }
      }
      return !ctx.inventoryFull();
    }

    if (step.type === 'craft') {
      // Skip intermediates we already have enough of (scaled by batch)
      if (i < plan.length - 1 && ctx.itemCount(step.itemCode) >= step.quantity * routine._currentBatch) continue;

      // Calculate how many we can craft with available materials
      const craftItem = gameData.getItem(step.itemCode);
      if (!craftItem?.craft) continue;

      let craftQty;
      if (i === plan.length - 1) {
        // Final step: craft as many as materials allow, up to remaining goal/claim.
        const finalGoal = claimMode
          ? claimGoal
          : Math.max(0, routine.rotation.goalTarget - routine.rotation.goalProgress);
        craftQty = Math.min(
          finalGoal,
          ...craftItem.craft.items.map(mat =>
            Math.floor(ctx.itemCount(mat.code) / mat.quantity)
          )
        );
      } else {
        // Intermediate step: craft enough for the batch
        const neededQty = step.quantity * routine._currentBatch - ctx.itemCount(step.itemCode);
        craftQty = Math.min(
          neededQty,
          ...craftItem.craft.items.map(mat =>
            Math.floor(ctx.itemCount(mat.code) / mat.quantity)
          )
        );
      }
      if (craftQty <= 0) continue; // need to gather more, loop will handle it

      // Craft at the workshop
      const workshops = await gameData.getWorkshops();
      const ws = workshops[craftItem.craft.skill];
      if (!ws) {
        log.warn(`[${ctx.name}] No workshop found for ${craftItem.craft.skill}`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      await moveTo(ctx, ws.x, ws.y);
      const result = await api.craft(step.itemCode, craftQty, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);

      log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: crafted ${step.itemCode} x${craftQty}`);

      // If this is the final step, record progress
      if (i === plan.length - 1) {
        const progressed = routine._recordProgress(craftQty);
        if (progressed) {
          log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: ${recipe.code} x${craftQty} complete (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
        } else {
          await routine._depositClaimItemsIfNeeded(ctx, { force: true });
          const active = routine._syncActiveClaimFromBoard();
          if (active) {
            log.info(`[${ctx.name}] Craft order progress: ${active.itemCode} remaining ${active.remainingQty}`);
          } else {
            log.info(`[${ctx.name}] Craft order fulfilled: ${recipe.code}`);
          }
        }

        // Allow re-withdrawal from bank for next batch
        routine.rotation.bankChecked = false;
        routine._currentBatch = 1;

      }
      return true;
    }
  }

  if (reserveGatherBlocked) {
    // Deposit completed recipe product to free inventory for gathering
    const productQty = ctx.itemCount(recipe.code);
    if (productQty > 0) {
      await depositBankItems(ctx, [{ code: recipe.code, quantity: productQty }], {
        reason: 'reserve pressure product deposit',
      });
      log.info(
        `[${ctx.name}] ${routine.rotation.currentSkill}: deposited ${recipe.code} x${productQty} to bank (reserve pressure relief)`,
      );
      return true;
    }

    log.info(`[${ctx.name}] ${routine.rotation.currentSkill}: reserve pressure blocked gathering; yielding to allow bank/deposit routines`);
    return false;
  }

  // If we get here, couldn't make progress — try next iteration
  // (bank deposit may have freed inventory, or we already have materials)
  return !ctx.inventoryFull();
}

export function equipForCraftFight(ctx, monsterCode) {
  return equipForCombat(ctx, monsterCode);
}

export async function handleUnwinnableCraftFight(ctx, routine, { monsterCode, itemCode, recipeCode, claimMode, simResult } = {}) {
  const hpLost = Number.isFinite(simResult?.hpLostPercent)
    ? `${Math.round(simResult.hpLostPercent)}%`
    : 'n/a';
  const simOutcome = simResult?.win ? 'win' : 'loss';

  log.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: skipping ${recipeCode || 'recipe'} fight step ${monsterCode} -> ${itemCode || 'drop'} (sim ${simOutcome}, hpLost ${hpLost})`);

  // Queue fight order so another character can farm the drop
  if (monsterCode && itemCode && routine.rotation) {
    const monster = gameData.getMonster(monsterCode);
    if (monster) {
      try {
        routine.rotation._enqueueOrder({
          requesterName: ctx.name,
          recipeCode: recipeCode || '',
          itemCode,
          sourceType: 'fight',
          sourceCode: monsterCode,
          sourceLevel: monster.level,
          quantity: 1,
        });
      } catch (_) { /* best-effort */ }
    }
  }

  if (claimMode) {
    await routine._blockAndReleaseClaim(ctx, 'combat_not_viable');
    return true;
  }

  routine.rotation.blockCurrentRecipe({
    reason: `combat not viable vs ${monsterCode}`,
    ctx,
  });
  await routine.rotation.forceRotate(ctx);
  return true;
}

export function inventoryReserve(ctx) {
  const capacity = Math.max(0, Number(ctx.inventoryCapacity()) || 0);
  if (capacity <= 1) return 0;

  const percentReserve = Math.ceil(capacity * RESERVE_PCT);
  const reserve = Math.max(RESERVE_MIN, percentReserve);
  return Math.min(RESERVE_MAX, reserve, capacity - 1);
}

export function usableInventorySpace(ctx) {
  const capacity = Math.max(0, Number(ctx.inventoryCapacity()) || 0);
  const used = Math.max(0, Number(ctx.inventoryCount()) || 0);
  const reserve = inventoryReserve(ctx);
  return Math.max(0, capacity - used - reserve);
}

export function batchSize(ctx, routine) {
  const remaining = routine.rotation.goalTarget - routine.rotation.goalProgress;
  if (remaining <= 1) return 1;

  const plan = routine.rotation.productionPlan;
  if (!plan) return 1;

  // Sum material quantities per single craft (bank + gather steps)
  let materialsPerCraft = 0;
  for (const step of plan) {
    if (step.type === 'bank' || step.type === 'gather' || step.type === 'fight') {
      materialsPerCraft += step.quantity;
    }
  }
  if (materialsPerCraft === 0) materialsPerCraft = 1;

  // Cap by reserve-aware inventory space
  const space = usableInventorySpace(ctx);
  const spaceLimit = Math.floor(space / materialsPerCraft);

  return Math.max(1, Math.min(remaining, spaceLimit));
}

export async function withdrawFromBank(ctx, routine, plan, finalRecipeCode, batchSizeVal = 1) {
  if (!plan) return;

  const maxUnits = usableInventorySpace(ctx);
  if (maxUnits <= 0) {
    log.info(`[${ctx.name}] Rotation crafting: skipping bank withdrawal (inventory reserve reached)`);
    return;
  }

  const excludeCodes = finalRecipeCode ? [finalRecipeCode] : [];
  const withdrawn = await withdrawPlanFromBank(ctx, plan, batchSizeVal, { excludeCodes, maxUnits });
  if (withdrawn.length > 0) {
    log.info(`[${ctx.name}] Rotation crafting: withdrew from bank: ${withdrawn.join(', ')}`);
  }
}
