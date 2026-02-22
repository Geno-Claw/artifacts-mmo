/**
 * Achievement hunter executor — selects and works toward uncompleted achievements.
 *
 * Scores each achievement by difficulty (level × remaining actions), picks the
 * easiest viable one, and dispatches to fight/gather/craft/task sub-handlers.
 * Viability checks match those used by existing executors (combat sim, skill
 * levels, recipe chain resolution, location reachability).
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { getCachedAccountDetails, getCachedAccountAchievements } from '../../services/account-cache.mjs';
import { optimizeForMonster } from '../../services/gear-optimizer.mjs';
import { equipForCombat, equipForGathering } from '../../services/gear-loadout.mjs';
import { restBeforeFight, withdrawFoodForFights } from '../../services/food-manager.mjs';
import { hpNeededForFight } from '../../services/combat-simulator.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';
import { moveTo, fightOnce, gatherOnce, parseFightResult, NoPathError, withdrawPlanFromBank, rawMaterialNeeded } from '../../helpers.mjs';

// Objective types we know how to score (and optionally execute)
const SCORABLE_TYPES = new Set([
  'combat_kill', 'gathering', 'crafting', 'combat_drop', 'task',
  'use', 'recycling', 'npc_buy', 'npc_sell',
]);
// Types we skip entirely (tracked naturally, not actionable)
const SKIP_TYPES = new Set(['combat_level', 'other']);

// ─── Main executor ──────────────────────────────────────────────────────────

export async function executeAchievement(ctx, routine) {
  const action = routine.rotation.achievementAction;
  if (!action) {
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  switch (action.type) {
    case 'fight':
      return executeFightObjective(ctx, routine, action);
    case 'gather':
      return executeGatherObjective(ctx, routine, action);
    case 'craft':
      return executeCraftObjective(ctx, routine, action);
    case 'task':
      return executeTaskObjective(ctx, routine);
    default:
      log.warn(`[${ctx.name}] Achievement: unsupported action type ${action.type}`);
      await routine.rotation.forceRotate(ctx);
      return true;
  }
}

// ─── Fight objective (combat_kill, combat_drop) ─────────────────────────────

async function executeFightObjective(ctx, routine, action) {
  const { monsterCode, loc } = action;

  // Equip optimal gear (cached per monster/level)
  const { simResult, ready = true } = await equipForCombat(ctx, monsterCode);
  if (!ready) {
    log.warn(`[${ctx.name}] Achievement: combat gear not ready for ${monsterCode}, deferring`);
    return false;
  }
  if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
    log.warn(`[${ctx.name}] Achievement: simulation predicts loss vs ${monsterCode}, rotating`);
    await routine.rotation.forceRotate(ctx);
    return true;
  }
  await prepareCombatPotions(ctx, monsterCode);

  // Withdraw food once per achievement goal
  if (!routine._foodWithdrawn) {
    const remaining = routine.rotation.goalTarget - routine.rotation.goalProgress;
    await withdrawFoodForFights(ctx, monsterCode, remaining);
    routine._foodWithdrawn = true;
  }

  // Re-withdraw food if bank routine deposited it mid-goal
  if (routine._foodWithdrawn && ctx.inventoryCount() === 0) {
    routine._foodWithdrawn = false;
  }

  // Navigate to monster
  try {
    await moveTo(ctx, loc.x, loc.y);
  } catch (err) {
    if (err instanceof NoPathError) {
      log.warn(`[${ctx.name}] Achievement: cannot reach ${monsterCode} at (${loc.x},${loc.y}), marking unreachable`);
      gameData.markLocationUnreachable('monster', monsterCode);
      await routine.rotation.forceRotate(ctx);
      return true;
    }
    throw err;
  }

  // Rest before fight
  if (!(await restBeforeFight(ctx, monsterCode))) {
    const minHp = hpNeededForFight(ctx, monsterCode);
    if (minHp === null) {
      log.warn(`[${ctx.name}] Achievement: ${monsterCode} unbeatable, rotating`);
      ctx.recordLoss(monsterCode);
      if (ctx.consecutiveLosses(monsterCode) >= routine.maxLosses) {
        await routine.rotation.forceRotate(ctx);
      }
      return true;
    }
    log.info(`[${ctx.name}] Achievement: insufficient HP for ${monsterCode}, yielding for rest`);
    return true;
  }

  // Fight
  const result = await fightOnce(ctx);
  const r = parseFightResult(result, ctx);
  const ach = routine.rotation.achievement;

  if (r.win) {
    ctx.clearLosses(monsterCode);
    routine._recordProgress(1);
    log.info(`[${ctx.name}] Achievement ${ach.code}: ${monsterCode} WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
    return !ctx.inventoryFull();
  }

  ctx.recordLoss(monsterCode);
  const losses = ctx.consecutiveLosses(monsterCode);
  log.warn(`[${ctx.name}] Achievement ${ach.code}: ${monsterCode} LOSS ${r.turns}t (${losses} losses)`);
  if (losses >= routine.maxLosses) {
    log.info(`[${ctx.name}] Achievement: too many losses vs ${monsterCode}, rotating`);
    await routine.rotation.forceRotate(ctx);
  }
  return true;
}

// ─── Gather objective ───────────────────────────────────────────────────────

async function executeGatherObjective(ctx, routine, action) {
  const { resource, loc } = action;

  // Safety: verify skill level (may have changed since setup)
  if (resource.level > ctx.skillLevel(resource.skill)) {
    log.warn(`[${ctx.name}] Achievement: ${resource.code} skill too low (need ${resource.skill} lv${resource.level}, have lv${ctx.skillLevel(resource.skill)}), rotating`);
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Equip gathering gear
  await equipForGathering(ctx, resource.skill);

  // Navigate to resource
  try {
    await moveTo(ctx, loc.x, loc.y);
  } catch (err) {
    if (err instanceof NoPathError) {
      log.warn(`[${ctx.name}] Achievement: cannot reach ${resource.code} at (${loc.x},${loc.y}), marking unreachable`);
      gameData.markLocationUnreachable('resource', resource.code);
      await routine.rotation.forceRotate(ctx);
      return true;
    }
    throw err;
  }

  // Gather
  const result = await gatherOnce(ctx);
  const items = result.details?.items || [];
  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  routine._recordProgress(totalQty);

  const ach = routine.rotation.achievement;
  log.info(`[${ctx.name}] Achievement ${ach.code}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
  return !ctx.inventoryFull();
}

// ─── Craft objective ────────────────────────────────────────────────────────

async function executeCraftObjective(ctx, routine, action) {
  const { item, plan: originalPlan, recipeCode } = action;
  const ach = routine.rotation.achievement;

  if (!originalPlan || !item) {
    log.warn(`[${ctx.name}] Achievement ${ach.code}: craft action missing plan or item, rotating`);
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Work on a copy so we don't mutate the action plan
  const plan = [...originalPlan];

  // Ensure final craft step is present
  if (plan.length === 0 || plan[plan.length - 1].itemCode !== recipeCode) {
    plan.push({ type: 'craft', itemCode: recipeCode, recipe: item.craft, quantity: 1 });
  }

  // Withdraw materials from bank (once per execute call, reset on next rotation)
  if (!routine.rotation.bankChecked) {
    routine.rotation.bankChecked = true;
    await withdrawPlanFromBank(ctx, plan, 1);
  }

  // Walk through production plan steps
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];

    if (step.type === 'bank') {
      const have = ctx.itemCount(step.itemCode);
      if (have >= step.quantity) continue;
      log.warn(`[${ctx.name}] Achievement ${ach.code}: need ${step.quantity}x ${step.itemCode} from bank, have ${have} — rotating`);
      await routine.rotation.forceRotate(ctx);
      return true;
    }

    if (step.type === 'gather') {
      const needed = rawMaterialNeeded(ctx, plan, step.itemCode, 1);
      if (ctx.itemCount(step.itemCode) >= needed) continue;

      const loc = await gameData.getResourceLocation(step.resource.code);
      if (!loc) {
        log.warn(`[${ctx.name}] Achievement ${ach.code}: cannot find location for ${step.resource.code}, rotating`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      await equipForGathering(ctx, step.resource.skill);
      try {
        await moveTo(ctx, loc.x, loc.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          gameData.markLocationUnreachable('resource', step.resource.code);
          await routine.rotation.forceRotate(ctx);
          return true;
        }
        throw err;
      }
      const result = await gatherOnce(ctx);
      const items = result.details?.items || [];
      log.info(`[${ctx.name}] Achievement ${ach.code}: gathering ${step.itemCode} for ${recipeCode} — got ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'}`);
      return !ctx.inventoryFull();
    }

    if (step.type === 'fight') {
      const needed = step.quantity;
      if (ctx.itemCount(step.itemCode) >= needed) continue;

      const monsterCode = step.monster.code;
      const monsterLoc = step.monsterLoc || await gameData.getMonsterLocation(monsterCode);
      if (!monsterLoc) {
        log.warn(`[${ctx.name}] Achievement ${ach.code}: cannot find location for monster ${monsterCode}, rotating`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      const { simResult, ready = true } = await equipForCombat(ctx, monsterCode);
      if (!ready) {
        log.warn(`[${ctx.name}] Achievement ${ach.code}: combat gear not ready for ${monsterCode}, rotating`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }
      if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
        log.warn(`[${ctx.name}] Achievement ${ach.code}: can't beat ${monsterCode} for ${step.itemCode}, rotating`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      await prepareCombatPotions(ctx, monsterCode);
      if (!(await restBeforeFight(ctx, monsterCode))) {
        const minHp = hpNeededForFight(ctx, monsterCode);
        if (minHp === null) {
          log.warn(`[${ctx.name}] Achievement ${ach.code}: ${monsterCode} unbeatable for ${step.itemCode}, rotating`);
          await routine.rotation.forceRotate(ctx);
          return true;
        }
        log.info(`[${ctx.name}] Achievement ${ach.code}: insufficient HP for ${monsterCode}, yielding for rest`);
        return true;
      }

      try {
        await moveTo(ctx, monsterLoc.x, monsterLoc.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          gameData.markLocationUnreachable('monster', monsterCode);
          await routine.rotation.forceRotate(ctx);
          return true;
        }
        throw err;
      }

      const result = await fightOnce(ctx);
      const r = parseFightResult(result, ctx);

      if (r.win) {
        ctx.clearLosses(monsterCode);
        log.info(`[${ctx.name}] Achievement ${ach.code}: farming ${step.itemCode} from ${monsterCode} — WIN ${r.turns}t${r.drops ? ' | ' + r.drops : ''} (have ${ctx.itemCount(step.itemCode)}/${needed})`);
      } else {
        ctx.recordLoss(monsterCode);
        const losses = ctx.consecutiveLosses(monsterCode);
        log.warn(`[${ctx.name}] Achievement ${ach.code}: farming ${monsterCode} for ${step.itemCode} — LOSS (${losses} losses)`);
        if (losses >= routine.maxLosses) {
          await routine.rotation.forceRotate(ctx);
        }
      }
      return !ctx.inventoryFull();
    }

    if (step.type === 'craft') {
      // Skip intermediates we already have enough of
      if (i < plan.length - 1 && ctx.itemCount(step.itemCode) >= step.quantity) continue;

      const craftItem = gameData.getItem(step.itemCode);
      if (!craftItem?.craft) continue;

      let craftQty;
      if (i === plan.length - 1) {
        // Final step: craft as many as materials allow, up to remaining goal
        const goalRemaining = Math.max(0, routine.rotation.goalTarget - routine.rotation.goalProgress);
        craftQty = Math.min(
          goalRemaining,
          ...craftItem.craft.items.map(mat =>
            Math.floor(ctx.itemCount(mat.code) / mat.quantity)
          )
        );
      } else {
        // Intermediate: craft just enough
        const neededQty = step.quantity - ctx.itemCount(step.itemCode);
        craftQty = Math.min(
          neededQty,
          ...craftItem.craft.items.map(mat =>
            Math.floor(ctx.itemCount(mat.code) / mat.quantity)
          )
        );
      }
      if (craftQty <= 0) continue;

      const workshops = await gameData.getWorkshops();
      const ws = workshops[craftItem.craft.skill];
      if (!ws) {
        log.warn(`[${ctx.name}] Achievement ${ach.code}: no workshop found for ${craftItem.craft.skill}, rotating`);
        await routine.rotation.forceRotate(ctx);
        return true;
      }

      await moveTo(ctx, ws.x, ws.y);
      const result = await api.craft(step.itemCode, craftQty, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);

      log.info(`[${ctx.name}] Achievement ${ach.code}: crafted ${step.itemCode} x${craftQty}`);

      // Final step — record progress
      if (i === plan.length - 1) {
        routine._recordProgress(craftQty);
        log.info(`[${ctx.name}] Achievement ${ach.code}: ${recipeCode} x${craftQty} complete (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
        routine.rotation.bankChecked = false;
      }
      return true;
    }
  }

  return !ctx.inventoryFull();
}

// ─── Task objective ─────────────────────────────────────────────────────────

async function executeTaskObjective(ctx, routine) {
  // Delegate to existing task executor — prefer monster tasks
  return routine._executeTaskByType(ctx, 'monsters');
}

// ─── Achievement selection & scoring ────────────────────────────────────────

/**
 * Fetch incomplete achievements, score them, and pick the easiest viable one.
 * Returns { achievement, objective, score, action } or null.
 */
export async function selectBestAchievement(ctx, config = {}) {
  // 1. Resolve account name
  const detailsResult = await getCachedAccountDetails();
  const details = detailsResult?.data;
  const account = details?.username || details?.account || details?.name;
  if (!account) {
    log.warn(`[${ctx.name}] Achievement: cannot resolve account name`);
    return null;
  }

  // 2. Fetch incomplete achievements (paginated, cached 10 min)
  const allAchievements = [];
  let page = 1;
  for (;;) {
    const result = await getCachedAccountAchievements(account, { completed: false, size: 100, page });
    const payload = result?.data;
    const list = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    allAchievements.push(...list);
    const totalPages = payload?.pages ?? 1;
    if (page >= totalPages || list.length < 100) break;
    page++;
  }

  if (allAchievements.length === 0) {
    log.info(`[${ctx.name}] Achievement: all achievements completed!`);
    return null;
  }

  // 3. Build allowed types set and blacklist
  const allowedTypes = new Set(config.achievementTypes || ['combat_kill', 'gathering', 'combat_drop', 'crafting', 'task']);
  const blacklist = new Set(config.achievementBlacklist || []);

  // 4. Get bank items for crafting viability checks
  const bankItems = await gameData.getBankItems();

  // 5. Score each achievement
  const candidates = [];
  for (const ach of allAchievements) {
    if (ach.completed_at) continue;
    if (blacklist.has(ach.code)) continue;

    const result = await scoreAchievement(ctx, ach, allowedTypes, bankItems);
    if (result) candidates.push(result);
  }

  if (candidates.length === 0) {
    log.info(`[${ctx.name}] Achievement: no viable achievements found`);
    return null;
  }

  // 6. Pick easiest (lowest score)
  candidates.sort((a, b) => a.score - b.score);

  // DEBUG: dump all scored candidates so we can validate scoring
  log.info(`[${ctx.name}] Achievement: ${candidates.length} viable candidates (top 20):`);
  for (const c of candidates.slice(0, 20)) {
    const obj = c.objective;
    const progress = obj.current ?? obj.progress ?? 0;
    const total = obj.total ?? 0;
    log.info(`  score=${String(c.score.toFixed(0)).padStart(8)} | ${c.achievement.code} / ${obj.type}:${obj.target || 'any'} (${progress}/${total})`);
  }

  return candidates[0];
}

/**
 * Score an entire achievement. For multi-objective achievements, finds the
 * first incomplete objective we can work on and sums all incomplete scores.
 * Returns { achievement, objective, score, action } or null.
 */
async function scoreAchievement(ctx, ach, allowedTypes, bankItems) {
  const objectives = ach.objectives || [];
  let totalScore = 0;
  let bestAction = null;
  let bestObjective = null;

  for (const obj of objectives) {
    const progress = obj.current ?? obj.progress ?? 0;
    const total = obj.total ?? 0;
    if (progress >= total) continue; // objective already done

    const remaining = total - progress;

    if (SKIP_TYPES.has(obj.type)) return null; // can't action on this achievement
    if (!SCORABLE_TYPES.has(obj.type)) return null;
    if (!allowedTypes.has(obj.type)) return null;

    const scored = await scoreObjective(ctx, obj, remaining, bankItems);
    if (!scored) return null; // not viable — skip entire achievement

    totalScore += scored.score;

    // Pick first incomplete objective as the one to work on
    if (!bestAction) {
      bestAction = scored.action;
      bestObjective = obj;
    }
  }

  if (!bestAction) return null;

  return {
    achievement: ach,
    objective: bestObjective,
    score: totalScore,
    action: bestAction,
  };
}

/**
 * Score and check viability of a single objective.
 * Returns { score, action } or null if not viable.
 */
async function scoreObjective(ctx, obj, remaining, bankItems) {
  const target = obj.target;

  switch (obj.type) {
    case 'combat_kill': {
      const monster = gameData.getMonster(target);
      if (!monster) return null;
      if (gameData.isLocationUnreachable('monster', target)) return null;

      const sim = await optimizeForMonster(ctx, target);
      if (!sim?.simResult?.win || sim.simResult.hpLostPercent > 90) return null;

      const loc = await gameData.getMonsterLocation(target);
      if (!loc) return null;

      return {
        score: monster.level * remaining,
        action: { type: 'fight', monsterCode: target, loc },
      };
    }

    case 'gathering': {
      // Target is the item code (drop), not the resource code
      let resource, drop;
      const dropInfo = gameData.getResourceDropInfo(target);
      if (dropInfo) {
        resource = dropInfo.resource;
        drop = dropInfo.drop;
      } else {
        resource = gameData.getResource(target);
      }
      if (!resource) return null;
      if (gameData.isLocationUnreachable('resource', resource.code)) return null;
      if (ctx.skillLevel(resource.skill) < resource.level) return null;

      const loc = await gameData.getResourceLocation(resource.code);
      if (!loc) return null;

      // Estimate gather actions needed: factor in drop rate and average quantity
      // rate is 1-in-N format: rate=1 means guaranteed, rate=200 means 1-in-200
      const probability = drop ? (1 / (drop.rate || 1)) : 1;
      const avgQty = ((drop?.min_quantity ?? 1) + (drop?.max_quantity ?? 1)) / 2;
      const expectedPerGather = Math.max(0.01, probability * avgQty);

      return {
        score: Math.sqrt(resource.level) * (remaining / expectedPerGather),
        action: { type: 'gather', resourceCode: resource.code, resource, loc },
      };
    }

    case 'crafting': {
      const item = gameData.getItem(target);
      if (!item?.craft) return null;
      if (ctx.skillLevel(item.craft.skill) < item.craft.level) return null;

      const plan = gameData.resolveRecipeChain(item.craft);
      if (!plan) return null;

      // Check gather/craft skill levels (bank-aware)
      const planCheck = gameData.canFulfillPlanWithBank(plan, ctx, bankItems);
      if (!planCheck.ok) return null;

      // Verify combat viability for fight steps
      for (const step of plan) {
        if (step.type !== 'fight') continue;
        const inBank = bankItems.get(step.itemCode) || 0;
        const inInventory = ctx.itemCount(step.itemCode);
        if (inBank + inInventory >= step.quantity) continue; // already have enough

        const sim = await optimizeForMonster(ctx, step.monster.code);
        if (!sim?.simResult?.win || sim.simResult.hpLostPercent > 90) return null;
      }

      // Check workshop exists
      const workshops = await gameData.getWorkshops();
      if (!workshops[item.craft.skill]) return null;

      return {
        score: item.craft.level * remaining,
        action: { type: 'craft', item, plan, recipeCode: target },
      };
    }

    case 'combat_drop': {
      const dropInfo = gameData.getMonsterForDrop(target);
      if (!dropInfo) return null;
      const { monster, drop } = dropInfo;
      if (gameData.isLocationUnreachable('monster', monster.code)) return null;

      const sim = await optimizeForMonster(ctx, monster.code);
      if (!sim?.simResult?.win || sim.simResult.hpLostPercent > 90) return null;

      const loc = await gameData.getMonsterLocation(monster.code);
      if (!loc) return null;

      // rate is 1-in-N format: rate=1 means guaranteed, rate=200 means 1-in-200
      const dropRate = Math.max(0.01, 1 / (drop.rate || 1));
      return {
        score: monster.level * (remaining / dropRate),
        action: { type: 'fight', monsterCode: monster.code, loc },
      };
    }

    case 'task': {
      // 1 task ≈ 200 kills worth of effort (accept → fight ~20-30× → complete)
      return {
        score: 200 * remaining,
        action: { type: 'task' },
      };
    }

    // Scored but not actively pursued in default config
    case 'use':
    case 'recycling':
    case 'npc_buy':
    case 'npc_sell':
      return { score: remaining, action: { type: obj.type, target } };

    default:
      return null;
  }
}
