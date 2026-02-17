import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';
import * as log from '../log.mjs';
import { moveTo, fightOnce } from '../helpers.mjs';
import { MONSTERS } from '../data/locations.mjs';
import { CHARACTER } from '../api.mjs';

export class FightMonstersTask extends BaseTask {
  /**
   * @param {string} monster — key from MONSTERS table
   * @param {object} [opts]
   * @param {number} [opts.restThreshold=30] — HP% below which to bail (let RestTask take over)
   * @param {number} [opts.priority=10]
   */
  constructor(monster, { restThreshold = 30, priority = 10 } = {}) {
    const loc = MONSTERS[monster];
    if (!loc) throw new Error(`Unknown monster: ${monster}`);

    super({ name: `Fight ${monster}`, priority, loop: true });
    this.monster = monster;
    this.loc = loc;
    this.restThreshold = restThreshold;
  }

  canRun(char) {
    if (char.level < this.loc.level) return false;
    if (state.hpPercent() < this.restThreshold) return false;
    if (state.inventoryFull()) return false;
    return true;
  }

  async execute(_char) {
    await moveTo(this.loc.x, this.loc.y);

    if (state.hpPercent() < this.restThreshold) return false;

    const result = await fightOnce();
    const f = result.fight;
    const cr = f.characters?.find(c => c.character_name === CHARACTER)
            || f.characters?.[0] || {};

    if (f.result === 'win') {
      const drops = cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '';
      const c = state.get();
      const task = c.task ? ` [task: ${c.task_progress}/${c.task_total}]` : '';
      log.info(`${this.monster}: WIN ${f.turns}t | +${cr.xp || 0}xp +${cr.gold || 0}g${drops ? ' | ' + drops : ''} (${cr.final_hp}hp)${task}`);
    } else {
      log.warn(`${this.monster}: LOSS ${f.turns}t`);
      return false;
    }

    return !state.inventoryFull() && state.hpPercent() >= this.restThreshold;
  }
}
