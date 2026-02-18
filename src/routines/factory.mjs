/**
 * Builds routine instances from JSON config entries.
 */
import { RestRoutine } from './rest.mjs';
import { DepositBankRoutine } from './deposit-bank.mjs';
import { CompleteNpcTaskRoutine, AcceptNpcTaskRoutine } from './do-task.mjs';
import { FightTaskMonsterRoutine } from './fight-task-monster.mjs';
import { FightMonstersRoutine } from './fight-monsters.mjs';
import { GatherResourceRoutine } from './gather-resource.mjs';
import { CancelNpcTaskRoutine } from './cancel-task.mjs';
import { SkillRotationRoutine } from './skill-rotation.mjs';

const ROUTINE_TYPES = {
  rest:              (cfg) => new RestRoutine(cfg),
  depositBank:       (cfg) => new DepositBankRoutine(cfg),
  completeNpcTask:   (cfg) => new CompleteNpcTaskRoutine(cfg),
  acceptNpcTask:     (cfg) => new AcceptNpcTaskRoutine(cfg),
  cancelNpcTask:     (cfg) => new CancelNpcTaskRoutine(cfg),
  fightTaskMonster:  (cfg) => new FightTaskMonsterRoutine(cfg),
  fightMonsters:     (cfg) => new FightMonstersRoutine(cfg.monster, cfg),
  gatherResource:    (cfg) => new GatherResourceRoutine(cfg.resource, cfg),
  skillRotation:     (cfg) => new SkillRotationRoutine(cfg),
};

export function buildRoutines(routineConfigs) {
  return routineConfigs.map(cfg => {
    const factory = ROUTINE_TYPES[cfg.type];
    if (!factory) throw new Error(`Unknown routine type: ${cfg.type}`);
    return factory(cfg);
  });
}
