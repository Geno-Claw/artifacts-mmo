import { RestTask } from './rest.mjs';
import { DepositBankTask } from './deposit-bank.mjs';
import { CompleteNpcTask, AcceptNpcTask } from './do-task.mjs';
import { FightMonstersTask } from './fight-monsters.mjs';
import { GatherResourceTask } from './gather-resource.mjs';

export { RestTask, DepositBankTask, CompleteNpcTask, AcceptNpcTask, FightMonstersTask, GatherResourceTask };

/** Default task set for auto-mode. */
export function defaultTasks() {
  return [
    new RestTask(),
    new DepositBankTask(),
    new CompleteNpcTask(),
    new AcceptNpcTask(),
    new FightMonstersTask('chicken', { priority: 10 }),
    // Uncomment / add as character grows:
    // new FightMonstersTask('cow', { priority: 11 }),
    // new GatherResourceTask('copper_ore', { priority: 8 }),
  ];
}
