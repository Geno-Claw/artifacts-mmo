import { BaseTask } from './base.mjs';
import * as log from '../log.mjs';
import { moveTo, fightOnce, restBeforeFight } from '../helpers.mjs';
import { MONSTERS } from '../data/locations.mjs';
import { canBeatMonster } from '../services/combat-simulator.mjs';

export class FightMonstersTask extends BaseTask {
  /**
   * @param {string} monster — key from MONSTERS table
   * @param {object} [opts]
   * @param {number} [opts.restThreshold=30] — HP% below which to bail (let RestTask take over)
   * @param {number} [opts.priority=10]
   */
  constructor(monster, { priority = 10 } = {}) {
    const loc = MONSTERS[monster];
    if (!loc) throw new Error(`Unknown monster: ${monster}`);

    super({ name: `Fight ${monster}`, priority, loop: true });
    this.monster = monster;
    this.loc = loc;
  }

  canRun(ctx) {
    if (ctx.get().level < this.loc.level) return false;
    if (!canBeatMonster(ctx, this.monster)) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    await moveTo(ctx, this.loc.x, this.loc.y);
    await restBeforeFight(ctx, this.monster);

    const result = await fightOnce(ctx);
    const f = result.fight;
    const cr = f.characters?.find(c => c.character_name === ctx.name)
            || f.characters?.[0] || {};

    if (f.result === 'win') {
      const drops = cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '';
      const c = ctx.get();
      const task = c.task ? ` [task: ${c.task_progress}/${c.task_total}]` : '';
      log.info(`[${ctx.name}] ${this.monster}: WIN ${f.turns}t | +${cr.xp || 0}xp +${cr.gold || 0}g${drops ? ' | ' + drops : ''} (${cr.final_hp}hp)${task}`);
    } else {
      log.warn(`[${ctx.name}] ${this.monster}: LOSS ${f.turns}t`);
      return false;
    }

    return !ctx.inventoryFull();
  }
}
