import { BaseRoutine } from './base.mjs';
import * as log from '../log.mjs';
import { moveTo, fightOnce, restBeforeFight, parseFightResult, equipForCombat, canUseRestAction, hasHealingFood } from '../helpers.mjs';
import { MONSTERS } from '../data/locations.mjs';
import { canBeatMonster, hpNeededForFight } from '../services/combat-simulator.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';

export class FightMonstersRoutine extends BaseRoutine {
  /**
   * @param {string} monster — key from MONSTERS table
   * @param {object} [opts]
   * @param {number} [opts.restThreshold=30] — HP% below which to bail (let RestRoutine take over)
   * @param {number} [opts.priority=10]
   */
  constructor(monster, { priority = 10 } = {}) {
    const loc = MONSTERS[monster];
    if (!loc) throw new Error(`Unknown monster: ${monster}`);

    super({ name: `Fight ${monster}`, priority, loop: true });
    this.monster = monster;
    this.loc = loc;
    this._gearOptimized = false;
  }

  canRun(ctx) {
    if (ctx.get().level < this.loc.level) return false;
    if (!canBeatMonster(ctx, this.monster)) return false;
    const minHp = hpNeededForFight(ctx, this.monster);
    if (minHp === null) return false;
    if (ctx.get().hp < minHp && !canUseRestAction(ctx) && !hasHealingFood(ctx)) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    // Optimize gear once when combat loop starts (not every fight)
    if (!this._gearOptimized) {
      const { ready = true } = await equipForCombat(ctx, this.monster);
      if (!ready) {
        log.warn(`[${ctx.name}] combat: gear not ready for ${this.monster}, deferring`);
        return false;
      }
      this._gearOptimized = true;
    }

    await prepareCombatPotions(ctx, this.monster);
    await moveTo(ctx, this.loc.x, this.loc.y);
    if (!(await restBeforeFight(ctx, this.monster))) {
      log.warn(`[${ctx.name}] combat: can't rest before fighting ${this.monster}, attempting fight anyway`);
    }

    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      const c = ctx.get();
      const task = c.task ? ` [task: ${c.task_progress}/${c.task_total}]` : '';
      log.info(`[${ctx.name}] ${this.monster}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''} (${r.finalHp}hp)${task}`);
    } else {
      log.warn(`[${ctx.name}] ${this.monster}: LOSS ${r.turns}t`);
      return false;
    }

    return !ctx.inventoryFull();
  }
}
