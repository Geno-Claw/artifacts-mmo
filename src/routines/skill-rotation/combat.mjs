/**
 * Combat executor — fight monsters for XP and drops.
 */
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, fightOnce, restBeforeFight, parseFightResult, equipForCombat, withdrawFoodForFights } from '../../helpers.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';

export async function executeCombat(ctx, routine) {
  let claim = await routine._ensureOrderClaim(ctx, 'fight');

  let monsterCode = routine.rotation.monster?.code || null;
  let loc = routine.rotation.monsterLoc;

  if (claim) {
    monsterCode = claim.sourceCode;
    loc = await gameData.getMonsterLocation(monsterCode);
    if (!loc) {
      log.warn(`[${ctx.name}] Order claim invalid for monster ${monsterCode}; blocking claim`);
      await routine._blockAndReleaseClaim(ctx, 'missing_monster_location');
      claim = null;
      monsterCode = routine.rotation.monster?.code || null;
      loc = routine.rotation.monsterLoc;
    }
  }

  if (!monsterCode || !loc) {
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Optimize gear for target monster (cached — only runs once per target)
  const { ready = true } = await equipForCombat(ctx, monsterCode);
  if (!ready) {
    const context = claim ? 'order fight' : 'combat';
    log.warn(`[${ctx.name}] ${context}: combat gear not ready for ${monsterCode}, deferring`);
    return false;
  }
  await prepareCombatPotions(ctx, monsterCode);

  // Withdraw food from bank for all remaining fights (once per combat goal)
  if (!claim && !routine._foodWithdrawn) {
    const remaining = routine.rotation.goalTarget - routine.rotation.goalProgress;
    await withdrawFoodForFights(ctx, monsterCode, remaining);
    routine._foodWithdrawn = true;
  }

  await moveTo(ctx, loc.x, loc.y);
  if (!(await restBeforeFight(ctx, monsterCode))) {
    const context = claim ? 'order fight' : 'combat';
    log.warn(`[${ctx.name}] ${context}: can't rest before fighting ${monsterCode}, attempting fight anyway`);
  }

  const result = await fightOnce(ctx);
  const r = parseFightResult(result, ctx);

  if (r.win) {
    ctx.clearLosses(monsterCode);

    if (routine._recordProgress(1)) {
      log.info(`[${ctx.name}] ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
    } else {
      await routine._depositClaimItemsIfNeeded(ctx);
      const active = routine._syncActiveClaimFromBoard();
      const remaining = active ? active.remainingQty : 0;
      log.info(`[${ctx.name}] Order fight ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (remaining ${remaining})`);
    }

    return !ctx.inventoryFull();
  }

  ctx.recordLoss(monsterCode);
  const losses = ctx.consecutiveLosses(monsterCode);
  log.warn(`[${ctx.name}] ${monsterCode}: LOSS ${r.turns}t (${losses} losses)`);

  if (routine._isClaimForSource('fight') && losses >= routine.maxLosses) {
    await routine._blockAndReleaseClaim(ctx, 'combat_losses');
    return true;
  }

  if (losses >= routine.maxLosses) {
    log.info(`[${ctx.name}] Too many losses, rotating to different skill`);
    await routine.rotation.forceRotate(ctx);
  }
  return true;
}
