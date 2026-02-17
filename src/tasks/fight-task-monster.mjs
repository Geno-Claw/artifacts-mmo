import { BaseTask } from './base.mjs';
import * as log from '../log.mjs';
import { moveTo, fightOnce } from '../helpers.mjs';
import { MONSTERS } from '../data/locations.mjs';

/**
 * Fights whatever monster the active NPC task requires.
 * Reads the target dynamically from character state each iteration.
 */
export class FightTaskMonsterTask extends BaseTask {
  constructor({ restThreshold = 30, priority = 20 } = {}) {
    super({ name: 'NPC Task', priority, loop: true });
    this.restThreshold = restThreshold;
  }

  canRun(ctx) {
    if (!ctx.hasTask()) return false;
    if (ctx.taskComplete()) return false;
    const loc = MONSTERS[ctx.get().task];
    if (!loc) return false;
    if (ctx.get().level < loc.level) return false;
    if (ctx.hpPercent() < this.restThreshold) return false;
    if (ctx.inventoryFull()) return false;
    return true;
  }

  async execute(ctx) {
    const c = ctx.get();
    const monster = c.task;
    const loc = MONSTERS[monster];

    await moveTo(ctx, loc.x, loc.y);

    if (ctx.hpPercent() < this.restThreshold) return false;

    const result = await fightOnce(ctx);
    const f = result.fight;
    const cr = f.characters?.find(ch => ch.character_name === ctx.name)
            || f.characters?.[0] || {};

    if (f.result === 'win') {
      const drops = cr.drops?.map(d => `${d.code}x${d.quantity}`).join(', ') || '';
      const fresh = ctx.get();
      const task = ` [task: ${fresh.task_progress}/${fresh.task_total}]`;
      log.info(`[${ctx.name}] ${monster}: WIN ${f.turns}t | +${cr.xp || 0}xp +${cr.gold || 0}g${drops ? ' | ' + drops : ''} (${cr.final_hp}hp)${task}`);
    } else {
      log.warn(`[${ctx.name}] ${monster}: LOSS ${f.turns}t`);
      return false;
    }

    if (ctx.taskComplete()) return false;
    return !ctx.inventoryFull() && ctx.hpPercent() >= this.restThreshold;
  }
}
