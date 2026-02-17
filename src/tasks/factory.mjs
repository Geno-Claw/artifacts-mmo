/**
 * Builds task instances from JSON config entries.
 */
import { RestTask } from './rest.mjs';
import { DepositBankTask } from './deposit-bank.mjs';
import { CompleteNpcTask, AcceptNpcTask } from './do-task.mjs';
import { FightTaskMonsterTask } from './fight-task-monster.mjs';
import { FightMonstersTask } from './fight-monsters.mjs';
import { GatherResourceTask } from './gather-resource.mjs';

const TASK_TYPES = {
  rest:              (cfg) => new RestTask(cfg),
  depositBank:       (cfg) => new DepositBankTask(cfg),
  completeNpcTask:   (cfg) => new CompleteNpcTask(cfg),
  acceptNpcTask:     (cfg) => new AcceptNpcTask(cfg),
  fightTaskMonster:  (cfg) => new FightTaskMonsterTask(cfg),
  fightMonsters:     (cfg) => new FightMonstersTask(cfg.monster, cfg),
  gatherResource:    (cfg) => new GatherResourceTask(cfg.resource, cfg),
};

export function buildTasks(taskConfigs) {
  return taskConfigs.map(cfg => {
    const factory = TASK_TYPES[cfg.type];
    if (!factory) throw new Error(`Unknown task type: ${cfg.type}`);
    return factory(cfg);
  });
}
