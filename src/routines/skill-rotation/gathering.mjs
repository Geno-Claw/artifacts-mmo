/**
 * Gathering executor — mining, woodcutting, fishing + smelting.
 */
import * as api from '../../api.mjs';
import * as log from '../../log.mjs';
import * as gameData from '../../services/game-data.mjs';
import { moveTo, gatherOnce, equipForGathering, NoPathError } from '../../helpers.mjs';

export async function executeGathering(ctx, routine) {
  let claim = await routine._ensureOrderClaim(ctx, 'gather');

  let resource = routine.rotation.resource;
  let loc = routine.rotation.resourceLoc;
  if (claim) {
    resource = gameData.getResource(claim.sourceCode);
    loc = resource ? await gameData.getResourceLocation(resource.code) : null;
    if (!resource || !loc) {
      log.warn(`[${ctx.name}] Order claim invalid for gather ${claim.sourceCode}; releasing claim`);
      await routine._clearActiveOrderClaim(ctx, { reason: 'missing_gather_source' });
      claim = null;
      resource = routine.rotation.resource;
      loc = routine.rotation.resourceLoc;
    }
  }

  if (!loc) {
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Safety: verify we can actually gather this resource
  if (resource && resource.level > ctx.skillLevel(resource.skill)) {
    if (claim) {
      await routine._blockAndReleaseClaim(ctx, 'insufficient_skill');
      return true;
    }
    log.warn(`[${ctx.name}] ${resource.code}: skill too low (need ${resource.skill} lv${resource.level}, have lv${ctx.skillLevel(resource.skill)}), rotating`);
    await routine.rotation.forceRotate(ctx);
    return true;
  }

  // Smelt/process raw materials before gathering more (skip while fulfilling orders)
  if (!claim) {
    const smelted = await routine._trySmelting(ctx);
    if (smelted) return !ctx.inventoryFull();
  }

  // Equip optimal gathering gear (tool + prospecting)
  await equipForGathering(ctx, resource?.skill || routine.rotation.currentSkill);

  try {
    await moveTo(ctx, loc.x, loc.y);
  } catch (err) {
    if (err instanceof NoPathError) {
      const resourceCode = resource?.code || 'unknown';
      log.warn(`[${ctx.name}] Cannot reach ${resourceCode} at (${loc.x},${loc.y}), marking unreachable`);
      gameData.markLocationUnreachable('resource', resourceCode);
      await routine.rotation.forceRotate(ctx);
      return true;
    }
    throw err;
  }
  const result = await gatherOnce(ctx);

  const items = result.details?.items || [];
  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  const progressed = routine._recordProgress(totalQty);

  if (progressed) {
    const res = routine.rotation.resource;
    log.info(`[${ctx.name}] ${res.code}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
  } else {
    await routine._depositClaimItemsIfNeeded(ctx);
    const active = routine._syncActiveClaimFromBoard();
    const remaining = active ? active.remainingQty : 0;
    log.info(`[${ctx.name}] Order gather ${resource.code}: ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} (remaining ${remaining})`);
  }

  return !ctx.inventoryFull();
}

export async function trySmelting(ctx, routine) {
  const skill = routine.rotation.currentSkill;
  const level = ctx.skillLevel(skill);

  const recipes = gameData.findItems({ craftSkill: skill, maxLevel: level });
  if (recipes.length === 0) return false;

  // Sort highest level first for best XP
  recipes.sort((a, b) => b.craft.level - a.craft.level);

  for (const item of recipes) {
    if (!item.craft?.items) continue;
    const maxQty = Math.min(
      ...item.craft.items.map(mat => Math.floor(ctx.itemCount(mat.code) / mat.quantity))
    );
    if (maxQty <= 0) continue;

    const workshops = await gameData.getWorkshops();
    const ws = workshops[skill];
    if (!ws) return false;

    await moveTo(ctx, ws.x, ws.y);
    const result = await api.craft(item.code, maxQty, ctx.name);
    await api.waitForCooldown(result);
    await ctx.refresh();

    routine.rotation.recordProgress(maxQty);
    log.info(`[${ctx.name}] ${skill}: smelted ${item.code} x${maxQty} (${routine.rotation.goalProgress}/${routine.rotation.goalTarget})`);
    return true;
  }

  return false;
}
