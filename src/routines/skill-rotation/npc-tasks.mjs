/**
 * NPC task executor — accept, fight, and complete monster tasks.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, fightOnce, parseFightResult } from '../../helpers.mjs';
import { restBeforeFight, withdrawFoodForFights } from '../../services/food-manager.mjs';
import { hpNeededForFight } from '../../services/combat-simulator.mjs';
import { equipForCombat } from '../../services/gear-loadout.mjs';
import { TASKS_MASTER } from '../../data/locations.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';

export async function executeNpcTask(ctx, routine) {
  return routine._executeTaskByType(ctx, 'monsters');
}

export async function executeItemTask(ctx, routine) {
  return routine._executeTaskByType(ctx, 'items');
}

export async function executeTaskByType(ctx, routine, preferredType) {
  if (!ctx.hasTask()) {
    if (preferredType === 'monsters') return routine._runNpcTaskFlow(ctx);
    return routine._runItemTaskFlow(ctx);
  }

  const c = ctx.get();
  let activeType = c.task_type;

  if (activeType !== 'monsters' && activeType !== 'items') {
    activeType = inferTaskType(c.task);
    if (activeType) {
      log.warn(`[${ctx.name}] Rotation: task_type "${c.task_type || 'missing'}" for ${c.task}, inferred ${activeType}`);
    }
  }

  if (!activeType) {
    log.warn(`[${ctx.name}] Rotation: unknown task_type "${c.task_type || 'missing'}" for ${c.task}, force-rotating`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return true;
  }

  if (activeType !== preferredType) {
    const selectedSkill = preferredType === 'monsters' ? 'npc_task' : 'item_task';
    const existingType = activeType === 'monsters' ? 'monster' : 'item';
    log.info(`[${ctx.name}] Rotation: ${selectedSkill} selected, continuing existing ${existingType} task (${c.task} ${c.task_progress}/${c.task_total})`);
  }

  if (activeType === 'monsters') return routine._runNpcTaskFlow(ctx);
  return routine._runItemTaskFlow(ctx);
}

export function inferTaskType(taskCode) {
  const isMonsterTask = !!gameData.getMonster(taskCode);
  const isItemTask = !!gameData.getItem(taskCode);
  if (isMonsterTask && !isItemTask) return 'monsters';
  if (isItemTask && !isMonsterTask) return 'items';
  return null;
}

export async function runNpcTaskFlow(ctx, routine) {
  // Accept a task if we don't have one
  if (!ctx.hasTask()) {
    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.acceptTask(ctx.name);
    ctx.applyActionResult(result);
    await api.waitForCooldown(result);
    const c = ctx.get();
    log.info(`[${ctx.name}] NPC Task: accepted ${c.task} (0/${c.task_total})`);
    return true;
  }

  // Complete task if done
  if (ctx.taskComplete()) {
    await moveTo(ctx, TASKS_MASTER.monsters.x, TASKS_MASTER.monsters.y);
    const result = await api.completeTask(ctx.name);
    ctx.applyActionResult(result);
    await api.waitForCooldown(result);
    log.info(`[${ctx.name}] NPC Task: completed (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);

    // Exchange task coins for rewards if targets are configured/detected
    await routine._exchangeTaskCoins(ctx);
    return true;
  }

  // Re-withdraw food if bank routine deposited it between goals
  if (routine._foodWithdrawn && ctx.inventoryCount() === 0) {
    routine._foodWithdrawn = false;
  }

  // Fight the task monster
  const c = ctx.get();
  const monster = c.task;
  const monsterLoc = await gameData.getMonsterLocation(monster);

  if (!monsterLoc) {
    log.warn(`[${ctx.name}] NPC Task: can't find monster ${monster}, skipping`);
    routine.rotation.goalProgress = routine.rotation.goalTarget; // force goal complete
    return true;
  }

  const monsterData = gameData.getMonster(monster);
  if (monsterData && monsterData.level > c.level) {
    log.warn(`[${ctx.name}] NPC Task: ${monster} too strong (lv${monsterData.level} > lv${c.level}), skipping`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return true;
  }

  if (ctx.consecutiveLosses(monster) >= routine.maxLosses) {
    log.warn(`[${ctx.name}] NPC Task: too many losses vs ${monster}, skipping`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return true;
  }

  // Optimize gear for NPC task monster — also validates fight is winnable
  const { simResult, ready = true } = await equipForCombat(ctx, monster);
  if (!ready) {
    log.warn(`[${ctx.name}] NPC Task: combat gear not ready for ${monster}, deferring`);
    return false;
  }
  if (!simResult || !simResult.win || simResult.hpLostPercent > 90) {
    log.warn(`[${ctx.name}] NPC Task: simulation predicts loss vs ${monster} even with optimal gear, skipping`);
    routine.rotation.goalProgress = routine.rotation.goalTarget;
    return true;
  }
  await prepareCombatPotions(ctx, monster);

  // Withdraw food from bank for all remaining task fights (once per NPC task)
  if (!routine._foodWithdrawn) {
    const taskRemaining = c.task_total - c.task_progress;
    const goalRemaining = routine.rotation.goalTarget - routine.rotation.goalProgress;
    const fightBudget = Math.min(taskRemaining, goalRemaining);
    await withdrawFoodForFights(ctx, monster, fightBudget);
    routine._foodWithdrawn = true;
  }

  await moveTo(ctx, monsterLoc.x, monsterLoc.y);
  if (!(await restBeforeFight(ctx, monster))) {
    const minHp = hpNeededForFight(ctx, monster);
    if (minHp === null) {
      log.warn(`[${ctx.name}] NPC Task: ${monster} unbeatable, skipping`);
      routine.rotation.goalProgress = routine.rotation.goalTarget;
      return true;
    }
    log.info(`[${ctx.name}] NPC Task: insufficient HP for ${monster}, yielding for rest`);
    return true;
  }

  const result = await fightOnce(ctx);
  const r = parseFightResult(result, ctx);

  if (r.win) {
    ctx.clearLosses(monster);
    routine.rotation.recordProgress(1);
    const fresh = ctx.get();
    log.info(`[${ctx.name}] ${monster}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} [task: ${fresh.task_progress}/${fresh.task_total}] (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
  } else {
    ctx.recordLoss(monster);
    log.warn(`[${ctx.name}] ${monster}: LOSS ${r.turns}t (${ctx.consecutiveLosses(monster)} losses)`);
    return false;
  }

  return !ctx.inventoryFull();
}
