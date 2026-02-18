import { BaseRoutine } from './base.mjs';
import * as log from '../log.mjs';
import { moveTo, fightOnce, restBeforeFight, parseFightResult, equipForCombat, canUseRestAction, hasHealingFood } from '../helpers.mjs';
import { MONSTERS, MAX_LOSSES_DEFAULT } from '../data/locations.mjs';
import { canBeatMonster, hpNeededForFight } from '../services/combat-simulator.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';

/**
 * Fights whatever monster the active NPC task requires.
 * Reads the target dynamically from character state each iteration.
 */
export class FightTaskMonsterRoutine extends BaseRoutine {
  constructor({ priority = 20, maxLosses = MAX_LOSSES_DEFAULT } = {}) {
    super({ name: 'NPC Task', priority, loop: true });
    this.maxLosses = maxLosses;
    this._lastOptimizedMonster = null;
  }

  canRun(ctx) {
    if (!ctx.hasTask()) return false;
    if (ctx.taskComplete()) return false;
    const monster = ctx.get().task;
    const loc = MONSTERS[monster];
    if (!loc) return false;
    if (ctx.get().level < loc.level) return false;
    if (ctx.consecutiveLosses(monster) >= this.maxLosses) return false;
    if (!canBeatMonster(ctx, monster)) return false;
    const minHp = hpNeededForFight(ctx, monster);
    if (minHp === null) return false;
    if (ctx.get().hp < minHp && !canUseRestAction(ctx) && !hasHealingFood(ctx)) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    const c = ctx.get();
    const monster = c.task;
    const loc = MONSTERS[monster];

    // Optimize gear when NPC task monster changes
    if (this._lastOptimizedMonster !== monster) {
      await equipForCombat(ctx, monster);
      this._lastOptimizedMonster = monster;
    }

    await prepareCombatPotions(ctx, monster);
    await moveTo(ctx, loc.x, loc.y);
    if (!(await restBeforeFight(ctx, monster))) return false;

    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monster);
      const fresh = ctx.get();
      const task = ` [task: ${fresh.task_progress}/${fresh.task_total}]`;
      log.info(`[${ctx.name}] ${monster}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${r.finalHp}hp)${task}`);
    } else {
      ctx.recordLoss(monster);
      log.warn(`[${ctx.name}] ${monster}: LOSS ${r.turns}t (${ctx.consecutiveLosses(monster)}/${this.maxLosses} losses)`);
      return false;
    }

    if (ctx.taskComplete()) return false;
    return !ctx.inventoryFull();
  }
}
