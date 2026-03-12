/**
 * Crafting executor — multi-step recipe crafting with bank withdrawals,
 * intermediate gathering, combat drops, and batch management.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, gatherOnce, fightOnce, parseFightResult, withdrawPlanFromBank, rawMaterialNeeded } from '../../helpers.mjs';
import { isCombatResultViable } from '../../services/combat-simulator.mjs';
import { getFightReadiness } from '../../services/food-manager.mjs';
import { equipForCombat, equipForGathering } from '../../services/gear-loadout.mjs';
import { depositBankItems } from '../../services/bank-ops.mjs';
import { buyItemFromNpc, carriedCurrencyCount, topUpNpcCurrency } from '../../services/npc-purchase.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';
import { RESERVE_PCT, RESERVE_MIN, RESERVE_MAX } from './constants.mjs';

const craftingLog = log.createLogger({ scope: 'routine.skill-rotation.crafting' });

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

  let bankItems = null;
  let pendingRewithdraw = null;

  const getBankItems = async () => {
    if (bankItems instanceof Map) return bankItems;
    const nextBank = await routine._getBankItems();
    bankItems = nextBank instanceof Map ? nextBank : new Map();
    return bankItems;
  };

  const notePendingRewithdraw = (step, needed, inInventory, inBank) => {
    const inventoryQuantity = Math.max(0, Number(inInventory) || 0);
    const bankQuantity = Math.max(0, Number(inBank) || 0);
    if (inventoryQuantity >= needed || bankQuantity <= 0 || (inventoryQuantity + bankQuantity) < needed) {
      return false;
    }

    if (!pendingRewithdraw) {
      pendingRewithdraw = {
        stepType: step.type,
        itemCode: step.itemCode,
        needed,
        inventoryQuantity,
        bankQuantity,
      };
    }
    return true;
  };

  const queueRewithdrawIfNeeded = () => {
    if (!pendingRewithdraw) return;
    routine.rotation.bankChecked = false;
    craftingLog.info(
      `[${ctx.name}] ${routine.rotation.currentSkill}: ${pendingRewithdraw.itemCode} still in bank after partial withdrawal, forcing re-withdraw next tick`,
      {
        event: 'craft.bank_withdraw.retry',
        reasonCode: 'inventory_full',
        context: { character: ctx.name },
        data: {
          skill: routine.rotation.currentSkill,
          recipeCode: recipe.code,
          ...pendingRewithdraw,
          inventoryCount: ctx.inventoryCount(),
          inventoryCapacity: ctx.inventoryCapacity(),
        },
      },
    );
    pendingRewithdraw = null;
  };

  // Re-withdraw if bank routine deposited our materials
  if (routine.rotation.bankChecked && ctx.inventoryCount() === 0) {
    routine.rotation.bankChecked = false;
  }

  // Withdraw matching ingredients from bank (scaled for batch)
  if (!routine.rotation.bankChecked) {
    routine.rotation.bankChecked = true;
    routine._currentBatch = claimMode ? 1 : routine._batchSize(ctx);
    await routine._withdrawFromBank(ctx, plan, recipe.code, routine._currentBatch);
    await getBankItems();

    // When fulfilling an order claim, enqueue sub-orders for any gather/fight
    // materials we still need after bank withdrawal.  This lets other characters
    // contribute the raw materials while we also farm them ourselves.
    if (claimMode && routine.orderBoard?.createOrders) {
      const bank = await getBankItems();
      for (const step of plan) {
        if (step.type === 'gather' && step.resource) {
          const needed = rawMaterialNeeded(ctx, plan, step.itemCode, routine._currentBatch);
          const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
          if (needed > have) {
            routine._enqueueGatherOrderForDeficit(step, claim, ctx, needed - have);
          }
        } else if (step.type === 'fight' && step.monster) {
          const needed = step.quantity * routine._currentBatch;
          const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
          if (needed > have) {
            routine._enqueueFightOrderForDeficit(step, claim, ctx, needed - have);
          }
        }
      }
    }
  }

  // Walk through production plan steps
  let reserveGatherBlocked = false;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];

    if (step.type === 'bank') {
      if (step.itemCode === 'gold') continue;
      // Must come from bank (event items, etc.) — already withdrawn above
      const have = ctx.itemCount(step.itemCode);
      if (have >= step.quantity) continue; // have enough for at least 1 craft

      const bank = await getBankItems();
      const inBank = bank.get(step.itemCode) || 0;
      const totalHave = have + inBank;
      if (notePendingRewithdraw(step, step.quantity, have, inBank)) continue;

      if (routine._isTaskRewardCode(step.itemCode)) {
        const missingQty = step.quantity - totalHave;
        if (routine.orderBoard.createOrders) {
          // Order-first: post exchange order and defer to workers
          routine._enqueueTaskExchangeOrder(ctx, step.itemCode, missingQty);
        } else {
          // Legacy: try proactive self-exchange
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
      }
      if (claimMode) {
        await routine._blockAndReleaseClaim(ctx, 'missing_bank_dependency');
      } else {
        craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: need ${step.quantity}x ${step.itemCode} from bank, have ${totalHave} — skipping recipe`, {
          event: 'craft.bank_dependency.missing',
          reasonCode: 'bank_unavailable',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            itemCode: step.itemCode,
            requiredQuantity: step.quantity,
            availableQuantity: totalHave,
            recipeCode: recipe.code,
          },
        });
        await routine.rotation.forceRotate(ctx);
      }
      return true;
    }

    if (step.type === 'gather') {
      // Check if we already have enough (accounting for batch + intermediates)
      const needed = rawMaterialNeeded(ctx, plan, step.itemCode, routine._currentBatch);
      const have = ctx.itemCount(step.itemCode);
      if (have >= needed) continue;

      const bank = await getBankItems();
      const inBank = bank.get(step.itemCode) || 0;
      if (notePendingRewithdraw(step, needed, have, inBank)) continue;

      if (step.resource.level > ctx.skillLevel(step.resource.skill)) {
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, 'insufficient_skill');
        } else {
          craftingLog.warn(
            `[${ctx.name}] ${step.resource.code}: skill too low ` +
            `(need ${step.resource.skill} lv${step.resource.level}, have lv${ctx.skillLevel(step.resource.skill)}), rotating`,
            {
              event: 'craft.gather.skill_insufficient',
              reasonCode: 'insufficient_skill',
              context: { character: ctx.name },
              data: {
                skill: routine.rotation.currentSkill,
                itemCode: step.itemCode,
                resourceCode: step.resource.code,
                requiredLevel: step.resource.level,
                currentLevel: ctx.skillLevel(step.resource.skill),
                gatherSkill: step.resource.skill,
                recipeCode: recipe.code,
              },
            },
          );
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }

      // Reserve only guards bank withdrawals (preventing overflow). Gathering
      // uses the natural inventoryFull() check in the loop below, so we don't
      // block here — avoids deadlock when inventory is above deposit threshold
      // but below capacity.
      if (ctx.inventoryFull()) {
        craftingLog.info(
          `[${ctx.name}] ${routine.rotation.currentSkill}: gather paused for ${step.itemCode}; ` +
          `inventory full (${ctx.inventoryCount()}/${ctx.inventoryCapacity()})`,
          {
            event: 'craft.gather.paused',
            reasonCode: 'inventory_full',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              itemCode: step.itemCode,
              inventoryCount: ctx.inventoryCount(),
              inventoryCapacity: ctx.inventoryCapacity(),
            },
          },
        );
        reserveGatherBlocked = true;
        continue;
      }

      // Gather from the resource in a loop (stay on-site to avoid deposit-bank preemption)
      const loc = await gameData.getResourceLocation(step.resource.code);
      if (!loc) {
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, 'missing_gather_location');
        } else {
          craftingLog.warn(`[${ctx.name}] Cannot find location for ${step.resource.code}, skipping recipe`, {
            event: 'craft.gather.location_missing',
            reasonCode: 'no_path',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              itemCode: step.itemCode,
              resourceCode: step.resource.code,
              recipeCode: recipe.code,
            },
          });
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }

      // Equip gathering gear for this resource's skill (e.g. alchemy gloves)
      await equipForGathering(ctx, step.resource.skill);

      await moveTo(ctx, loc.x, loc.y);
      while (ctx.itemCount(step.itemCode) < needed && !ctx.inventoryFull()) {
        // Yield for urgent routines (e.g. events) — return false to let scheduler
        // pick the urgent routine via its own preemption logic on the next tick.
        if (routine._hasUrgentPreemption(ctx)) {
          craftingLog.info(`[${ctx.name}] ${routine.rotation.currentSkill}: yielding gather loop for urgent routine`, {
            event: 'craft.gather.preempted',
            reasonCode: 'preempted_by_higher_priority',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              itemCode: step.itemCode,
              recipeCode: recipe.code,
            },
          });
          return false;
        }
        const result = await gatherOnce(ctx);
        const items = result.details?.items || [];
        craftingLog.debug(
          `[${ctx.name}] ${routine.rotation.currentSkill}: gathering ${step.itemCode} for ${recipe.code} — ` +
          `got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} ` +
          `(${ctx.itemCount(step.itemCode)}/${needed})`,
          {
            event: 'craft.gather.progress',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              itemCode: step.itemCode,
              recipeCode: recipe.code,
              needed,
              currentQuantity: ctx.itemCount(step.itemCode),
              items: items.map(i => ({ code: i.code, quantity: i.quantity })),
            },
          },
        );
      }
      if (ctx.inventoryFull()) return false;
      continue;
    }

    if (step.type === 'fight') {
      // Check if we already have enough from bank withdrawal or prior fights
      const needed = step.quantity * routine._currentBatch;
      const have = ctx.itemCount(step.itemCode);
      if (have >= needed) continue;

      const bank = await getBankItems();
      const inBank = bank.get(step.itemCode) || 0;
      if (notePendingRewithdraw(step, needed, have, inBank)) continue;

      // Find monster location
      const monsterCode = step.monster.code;
      const monsterLoc = step.monsterLoc || await gameData.getMonsterLocation(monsterCode);
      if (!monsterLoc) {
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, 'missing_fight_location');
        } else {
          craftingLog.warn(`[${ctx.name}] Cannot find location for monster ${monsterCode}, skipping recipe`, {
            event: 'craft.fight.location_missing',
            reasonCode: 'no_path',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              recipeCode: recipe.code,
              itemCode: step.itemCode,
              monsterCode,
            },
          });
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }

      // Equip for combat against this monster
      const { simResult, ready = true } = await routine._equipForCraftFight(ctx, monsterCode);
      if (!ready) {
        if (claimMode) {
          craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: combat gear not ready for ${monsterCode}, blocking claim`, {
            event: 'craft.fight.gear_not_ready',
            reasonCode: 'routine_conditions_changed',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              recipeCode: recipe.code,
              itemCode: step.itemCode,
              monsterCode,
              claimMode: true,
            },
          });
          await routine._blockAndReleaseClaim(ctx, `combat_gear_not_ready:${monsterCode}`);
          return true;
        }
        craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: combat gear not ready for ${monsterCode}, blocking recipe and rotating`, {
          event: 'craft.fight.gear_not_ready',
          reasonCode: 'routine_conditions_changed',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            monsterCode,
            claimMode: false,
          },
        });
        routine.rotation.blockCurrentRecipe({
          reason: `combat gear not ready vs ${monsterCode}`,
          ctx,
        });
        await routine.rotation.forceRotate(ctx);
        return true;
      }
      if (!isCombatResultViable(simResult)) {
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
      await routine._ensureFightFood(ctx, monsterCode, needed - have);

      const readiness = await getFightReadiness(ctx, monsterCode);
      if (readiness.status !== 'ready') {
        if (readiness.status === 'unwinnable') {
          await routine._handleUnwinnableCraftFight(ctx, {
            monsterCode,
            itemCode: step.itemCode,
            recipeCode: recipe.code,
            claimMode,
            simResult,
          });
          return true;
        }
        craftingLog.info(`[${ctx.name}] ${routine.rotation.currentSkill}: insufficient HP for ${monsterCode}, yielding for rest`, {
          event: 'craft.fight.rest_required',
          reasonCode: 'yield_for_rest',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            monsterCode,
            requiredHp: readiness.requiredHp,
            currentHp: ctx.get().hp,
          },
        });
        return routine._yield('yield_for_rest', {
          skill: routine.rotation.currentSkill,
          recipeCode: recipe.code,
          itemCode: step.itemCode,
          monsterCode,
          requiredHp: readiness.requiredHp,
          currentHp: ctx.get().hp,
        });
      }

      await moveTo(ctx, monsterLoc.x, monsterLoc.y);
      const result = await fightOnce(ctx);
      const r = parseFightResult(result, ctx);

      if (r.win) {
        ctx.clearLosses(monsterCode);
        craftingLog.debug(`[${ctx.name}] ${routine.rotation.currentSkill}: farming ${step.itemCode} from ${monsterCode} for ${recipe.code} — WIN ${r.turns}t${r.drops ? ' | ' + r.drops : ''} (have ${ctx.itemCount(step.itemCode)}/${needed})`, {
          event: 'craft.fight.progress',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            monsterCode,
            turns: r.turns,
            drops: r.drops || '',
            currentQuantity: ctx.itemCount(step.itemCode),
            needed,
          },
        });
      } else {
        ctx.recordLoss(monsterCode);
        const losses = ctx.consecutiveLosses(monsterCode);
        craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: farming ${monsterCode} for ${step.itemCode} — LOSS (${losses} losses)`, {
          event: 'craft.fight.lost',
          reasonCode: 'unwinnable_combat',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            monsterCode,
            losses,
          },
        });
        if (losses >= routine.maxLosses) {
          if (claimMode) {
            await routine._blockAndReleaseClaim(ctx, 'combat_losses');
          } else {
            craftingLog.info(`[${ctx.name}] Too many losses farming ${monsterCode}, rotating`, {
              event: 'craft.rotation.loss_limit',
              reasonCode: 'unwinnable_combat',
              context: { character: ctx.name },
              data: {
                skill: routine.rotation.currentSkill,
                recipeCode: recipe.code,
                itemCode: step.itemCode,
                monsterCode,
                losses,
                maxLosses: routine.maxLosses,
              },
            });
            await routine.rotation.forceRotate(ctx);
          }
        }
      }
      return !ctx.inventoryFull();
    }

    if (step.type === 'npc_trade') {
      // Buy item from NPC using currency materials already in inventory
      const needed = step.quantity * routine._currentBatch;
      const have = ctx.itemCount(step.itemCode);
      if (have >= needed) continue;

      const bank = await getBankItems();
      const inBank = bank.get(step.itemCode) || 0;
      if (notePendingRewithdraw(step, needed, have, inBank)) continue;

      const buyQty = needed - have;
      const currencyNeeded = buyQty * step.buyPrice;
      const currencyTopUp = await topUpNpcCurrency(ctx, step.currency, currencyNeeded, {
        reason: `craft npc_trade ${step.itemCode}`,
      });
      if (currencyTopUp.error) {
        craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: failed to top up ${step.currency} for ${step.itemCode}: ${currencyTopUp.error.message}`, {
          event: 'craft.npc_trade.currency_top_up_failed',
          reasonCode: 'bank_unavailable',
          context: { character: ctx.name },
          error: currencyTopUp.error,
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            currency: step.currency,
            currencyNeeded,
          },
        });
      }

      if (carriedCurrencyCount(ctx, step.currency) < currencyNeeded) {
        // Not enough currency yet — gather steps should handle it on next pass
        craftingLog.debug(`[${ctx.name}] ${routine.rotation.currentSkill}: need ${currencyNeeded}x ${step.currency} for NPC trade ${step.itemCode}, have ${ctx.itemCount(step.currency)}`, {
          event: 'craft.npc_trade.currency_needed',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            currency: step.currency,
            currencyNeeded,
            currentCurrency: ctx.itemCount(step.currency),
          },
        });
        continue;
      }

      const purchase = await buyItemFromNpc(ctx, {
        npcCode: step.npcCode,
        itemCode: step.itemCode,
        quantity: buyQty,
      });
      if (!purchase.ok && purchase.reason === 'npc_not_found') {
        craftingLog.warn(`[${ctx.name}] Cannot find NPC location for ${step.npcCode}`, {
          event: 'craft.npc_trade.location_missing',
          reasonCode: 'no_path',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            npcCode: step.npcCode,
          },
        });
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, `npc_inaccessible:${step.npcCode}`);
        } else {
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }
      if (!purchase.ok && purchase.reason === 'condition_not_met') {
        craftingLog.warn(`[${ctx.name}] Cannot access NPC ${step.npcCode}: ${purchase.error?.message || 'condition not met'}`, {
          event: 'craft.npc_trade.inaccessible',
          reasonCode: 'routine_conditions_changed',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            npcCode: step.npcCode,
          },
        });
        if (claimMode) {
          await routine._blockAndReleaseClaim(ctx, `npc_inaccessible:${step.npcCode}`);
        } else {
          await routine.rotation.forceRotate(ctx);
        }
        return true;
      }
      if (!purchase.ok) {
        return true;
      }
      craftingLog.info(`[${ctx.name}] ${routine.rotation.currentSkill}: NPC trade — bought ${step.itemCode} x${buyQty} from ${step.npcCode}`, {
        event: 'craft.npc_trade.completed',
        context: { character: ctx.name },
        data: {
          skill: routine.rotation.currentSkill,
          recipeCode: recipe.code,
          itemCode: step.itemCode,
          npcCode: step.npcCode,
          quantity: buyQty,
        },
      });
      continue;
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
        craftingLog.warn(`[${ctx.name}] No workshop found for ${craftItem.craft.skill}`, {
          event: 'craft.workshop.missing',
          reasonCode: 'no_path',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            itemCode: step.itemCode,
            craftSkill: craftItem.craft.skill,
          },
        });
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      await moveTo(ctx, ws.x, ws.y);
      const result = await api.craft(step.itemCode, craftQty, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);
      routine._craftRewithdrawRetries = 0;

      craftingLog.debug(`[${ctx.name}] ${routine.rotation.currentSkill}: crafted ${step.itemCode} x${craftQty}`, {
        event: 'craft.step.completed',
        context: { character: ctx.name },
        data: {
          skill: routine.rotation.currentSkill,
          recipeCode: recipe.code,
          itemCode: step.itemCode,
          quantity: craftQty,
        },
      });

      // If this is the final step, record progress
      if (i === plan.length - 1) {
        const progressed = routine._recordProgress(craftQty);
        if (progressed) {
          craftingLog.info(`[${ctx.name}] ${routine.rotation.currentSkill}: ${recipe.code} x${craftQty} complete (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`, {
            event: 'craft.recipe.completed',
            context: { character: ctx.name },
            data: {
              skill: routine.rotation.currentSkill,
              recipeCode: recipe.code,
              quantity: craftQty,
              goalProgress: routine.rotation.goalProgress,
              goalTarget: routine.rotation.goalTarget,
            },
          });
        } else {
          await routine._depositClaimItemsIfNeeded(ctx, { force: true });
          const active = routine._syncActiveClaimFromBoard();
          if (active) {
            craftingLog.info(`[${ctx.name}] Craft order progress: ${active.itemCode} remaining ${active.remainingQty}`, {
              event: 'craft.claim.progress',
              context: { character: ctx.name },
              data: {
                orderId: active.orderId,
                itemCode: active.itemCode,
                remainingQty: active.remainingQty,
                recipeCode: recipe.code,
              },
            });
          } else {
            craftingLog.info(`[${ctx.name}] Craft order fulfilled: ${recipe.code}`, {
              event: 'craft.claim.fulfilled',
              context: { character: ctx.name },
              data: {
                recipeCode: recipe.code,
              },
            });
          }
        }

        // Allow re-withdrawal from bank for next batch
        routine.rotation.bankChecked = false;
        routine._currentBatch = 1;

      }
      queueRewithdrawIfNeeded();
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
      craftingLog.debug(
        `[${ctx.name}] ${routine.rotation.currentSkill}: deposited ${recipe.code} x${productQty} to bank (reserve pressure relief)`,
        {
          event: 'craft.reserve_pressure.deposit',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            quantity: productQty,
          },
        },
      );
      queueRewithdrawIfNeeded();
      return true;
    }

    craftingLog.info(`[${ctx.name}] ${routine.rotation.currentSkill}: reserve pressure blocked gathering; yielding to allow bank/deposit routines`, {
      event: 'craft.reserve_pressure.yield',
      reasonCode: 'yield_for_deposit',
      context: { character: ctx.name },
      data: {
        skill: routine.rotation.currentSkill,
        recipeCode: recipe.code,
      },
    });
    queueRewithdrawIfNeeded();
    return false;
  }

  // If we get here, couldn't make progress — try next iteration.
  // Circuit breaker: if materials don't fit even after a retry, bail out
  // instead of looping (deposit → withdraw → deposit → withdraw).
  if (pendingRewithdraw && ctx.inventoryFull()) {
    routine._craftRewithdrawRetries = (routine._craftRewithdrawRetries || 0) + 1;
    if (routine._craftRewithdrawRetries > 1) {
      craftingLog.warn(
        `[${ctx.name}] ${routine.rotation.currentSkill}: materials for ${recipe.code} exceed inventory capacity, bailing out`,
        {
          event: 'craft.materials_exceed_inventory',
          reasonCode: 'inventory_full',
          context: { character: ctx.name },
          data: {
            skill: routine.rotation.currentSkill,
            recipeCode: recipe.code,
            retries: routine._craftRewithdrawRetries,
            pendingItem: pendingRewithdraw.itemCode,
            inventoryCount: ctx.inventoryCount(),
            inventoryCapacity: ctx.inventoryCapacity(),
          },
        },
      );
      routine._craftRewithdrawRetries = 0;
      if (claimMode) {
        await routine._blockAndReleaseClaim(ctx, 'materials_exceed_inventory');
      } else {
        routine.rotation.blockCurrentRecipe({
          reason: `materials exceed inventory for ${recipe.code}`,
          ctx,
        });
        await routine.rotation.forceRotate(ctx);
      }
      return true;
    }
    // First retry — allow one more attempt in case bank state changed.
    queueRewithdrawIfNeeded();
    return false;
  }

  // No stuck condition — reset counter.
  routine._craftRewithdrawRetries = 0;
  queueRewithdrawIfNeeded();
  return !ctx.inventoryFull();
}

export function equipForCraftFight(ctx, monsterCode) {
  return equipForCombat(ctx, monsterCode);
}

export async function handleUnwinnableCraftFight(ctx, routine, { monsterCode, itemCode, recipeCode, claimMode, simResult } = {}) {
  const winRate = Number.isFinite(simResult?.winRate)
    ? `${simResult.winRate.toFixed(1)}%`
    : 'n/a';
  const simOutcome = isCombatResultViable(simResult) ? 'viable' : 'blocked';

  craftingLog.warn(`[${ctx.name}] ${routine.rotation.currentSkill}: skipping ${recipeCode || 'recipe'} fight step ${monsterCode} -> ${itemCode || 'drop'} (sim ${simOutcome}, winRate ${winRate})`, {
    event: 'craft.fight.skipped',
    reasonCode: 'unwinnable_combat',
    context: { character: ctx.name },
    data: {
      skill: routine.rotation.currentSkill,
      recipeCode: recipeCode || null,
      monsterCode,
      itemCode: itemCode || null,
      simOutcome,
      winRate: simResult?.winRate ?? null,
      requiredHp: simResult?.requiredHp ?? null,
      claimMode,
    },
  });

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
    if (step.type === 'bank' || step.type === 'gather' || step.type === 'fight' || step.type === 'npc_trade') {
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

  let maxUnits = usableInventorySpace(ctx);
  if (maxUnits <= 0) {
    // Reserve blocks all withdrawal — fall back to raw capacity so crafting
    // isn't completely prevented when food/keep-coded items fill the reserve.
    const rawSpace = Math.max(0, ctx.inventoryCapacity() - ctx.inventoryCount());
    if (rawSpace <= 0) {
      craftingLog.info(`[${ctx.name}] Rotation crafting: skipping bank withdrawal (inventory full)`, {
        event: 'craft.bank_withdraw.skipped',
        reasonCode: 'inventory_full',
        context: { character: ctx.name },
        data: {
          finalRecipeCode: finalRecipeCode || null,
          batchSize: batchSizeVal,
          inventoryCount: ctx.inventoryCount(),
          inventoryCapacity: ctx.inventoryCapacity(),
        },
      });
      routine.rotation.bankChecked = true;
      return;
    }
    maxUnits = rawSpace;
    batchSizeVal = 1;
  }

  const excludeCodes = finalRecipeCode ? [finalRecipeCode] : [];
  const withdrawn = await withdrawPlanFromBank(ctx, plan, batchSizeVal, { excludeCodes, maxUnits });
  if (withdrawn.length > 0) {
    craftingLog.debug(`[${ctx.name}] Rotation crafting: withdrew from bank: ${withdrawn.join(', ')}`, {
      event: 'craft.bank_withdraw.completed',
      context: { character: ctx.name },
      data: {
        finalRecipeCode: finalRecipeCode || null,
        batchSize: batchSizeVal,
        withdrawn,
      },
    });
  }
}
