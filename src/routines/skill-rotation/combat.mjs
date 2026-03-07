/**
 * Combat executor — fight monsters for XP and drops.
 */
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, fightOnce, parseFightResult, NoPathError } from '../../helpers.mjs';
import { getFightReadiness, withdrawFoodForFights } from '../../services/food-manager.mjs';
import { equipForCombat } from '../../services/gear-loadout.mjs';
import { prepareCombatPotions } from '../../services/potion-manager.mjs';

const combatLog = log.createLogger({ scope: 'routine.skill-rotation.combat' });

export async function executeCombat(ctx, routine) {
  const logger = log.forCharacter(combatLog, ctx);
  // Re-withdraw food if bank routine deposited it mid-goal
  if (routine._foodWithdrawn && ctx.inventoryCount() === 0) {
    routine._foodWithdrawn = false;
  }

  let claim = await routine._ensureOrderClaim(ctx, 'fight');

  let monsterCode = routine.rotation.monster?.code || null;
  let loc = routine.rotation.monsterLoc;

  if (claim) {
    monsterCode = claim.sourceCode;
    loc = await gameData.getMonsterLocation(monsterCode);
    if (!loc) {
      logger.warn(`[${ctx.name}] Order claim invalid for monster ${monsterCode}; blocking claim`, {
        event: 'combat.claim.invalid',
        reasonCode: 'routine_conditions_changed',
        data: {
          orderId: claim.orderId,
          monsterCode,
          sourceType: claim.sourceType,
        },
      });
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
    const action = claim ? 'blocking claim' : 'deferring';
    logger.warn(`[${ctx.name}] ${context}: combat gear not ready for ${monsterCode}, ${action}`, {
      event: 'combat.gear.not_ready',
      reasonCode: 'routine_conditions_changed',
      data: {
        monsterCode,
        sourceType: claim?.sourceType || null,
      },
    });
    if (claim) {
      await routine._blockAndReleaseClaim(ctx, `combat_gear_not_ready:${monsterCode}`);
      return true;
    }
    return false;
  }
  await prepareCombatPotions(ctx, monsterCode);

  // Withdraw food from bank for remaining fights (once per combat goal/claim)
  if (!routine._foodWithdrawn) {
    const remaining = claim
      ? gameData.estimatedFightsForDrops(monsterCode, claim.itemCode, claim.remainingQty || 20)
      : (routine.rotation.goalTarget - routine.rotation.goalProgress);
    await withdrawFoodForFights(ctx, monsterCode, remaining);
    routine._foodWithdrawn = true;
  }

  try {
    await moveTo(ctx, loc.x, loc.y);
  } catch (err) {
    if (err instanceof NoPathError) {
      logger.warn(`[${ctx.name}] Cannot reach ${monsterCode} at (${loc.x},${loc.y}), marking unreachable`, {
        event: 'combat.path.unreachable',
        reasonCode: 'no_path',
        data: {
          monsterCode,
          x: loc.x,
          y: loc.y,
        },
      });
      gameData.markLocationUnreachable('monster', monsterCode);
      await routine.rotation.forceRotate(ctx);
      return true;
    }
    throw err;
  }
  const readiness = await getFightReadiness(ctx, monsterCode);
  if (readiness.status !== 'ready') {
    const context = claim ? 'order fight' : 'combat';
    if (readiness.status === 'unwinnable') {
      const action = claim ? 'blocking claim' : 'rotating';
      logger.warn(`[${ctx.name}] ${context}: ${monsterCode} not safely fightable, ${action}`, {
        event: 'combat.unwinnable',
        reasonCode: 'unwinnable_combat',
        data: {
          monsterCode,
          sourceType: claim?.sourceType || null,
          requiredHp: readiness.requiredHp,
          maxHp: readiness.maxHp,
        },
      });
      if (claim) {
        await routine._blockAndReleaseClaim(ctx, `combat_not_viable:${monsterCode}`);
      } else {
        await routine.rotation.forceRotate(ctx);
      }
      return true;
    }
    logger.info(`[${ctx.name}] ${context}: insufficient HP for ${monsterCode}, yielding for rest`, {
      event: 'combat.rest.required',
      reasonCode: 'yield_for_rest',
      data: {
        monsterCode,
        requiredHp: readiness.requiredHp,
        currentHp: ctx.get().hp,
        sourceType: claim?.sourceType || null,
      },
    });
    return routine._yield('yield_for_rest', {
      monsterCode,
      requiredHp: readiness.requiredHp,
      currentHp: ctx.get().hp,
      sourceType: claim?.sourceType || null,
    });
  }

  const result = await fightOnce(ctx);
  const r = parseFightResult(result, ctx);

  if (r.win) {
    ctx.clearLosses(monsterCode);

    if (routine._recordProgress(1)) {
      logger.debug(`[${ctx.name}] ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`, {
        event: 'combat.fight.won',
        data: {
          monsterCode,
          turns: r.turns,
          xp: r.xp,
          gold: r.gold,
          drops: r.drops || '',
          goalProgress: routine.rotation.goalProgress,
          goalTarget: routine.rotation.goalTarget,
          inventoryFull: ctx.inventoryFull(),
        },
      });
    } else {
      await routine._depositClaimItemsIfNeeded(ctx);
      const active = routine._syncActiveClaimFromBoard();
      const remaining = active ? active.remainingQty : 0;
      logger.info(`[${ctx.name}] Order fight ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (remaining ${remaining})`, {
        event: 'combat.claim.progress',
        data: {
          orderId: active?.orderId || routine._activeOrderClaim?.orderId || null,
          itemCode: active?.itemCode || routine._activeOrderClaim?.itemCode || null,
          monsterCode,
          remainingQty: remaining,
          turns: r.turns,
          xp: r.xp,
          gold: r.gold,
          drops: r.drops || '',
        },
      });
    }

    return !ctx.inventoryFull();
  }

  ctx.recordLoss(monsterCode);
  const losses = ctx.consecutiveLosses(monsterCode);
  logger.warn(`[${ctx.name}] ${monsterCode}: LOSS ${r.turns}t (${losses} losses)`, {
    event: 'combat.fight.lost',
    reasonCode: 'unwinnable_combat',
    data: {
      monsterCode,
      turns: r.turns,
      losses,
      sourceType: claim?.sourceType || null,
    },
  });

  if (routine._isClaimForSource('fight') && losses >= routine.maxLosses) {
    await routine._blockAndReleaseClaim(ctx, 'combat_losses');
    return true;
  }

  if (losses >= routine.maxLosses) {
    logger.info(`[${ctx.name}] Too many losses, rotating to different skill`, {
      event: 'combat.rotation.loss_limit',
      reasonCode: 'unwinnable_combat',
      data: {
        monsterCode,
        losses,
        maxLosses: routine.maxLosses,
      },
    });
    await routine.rotation.forceRotate(ctx);
  }
  return true;
}
