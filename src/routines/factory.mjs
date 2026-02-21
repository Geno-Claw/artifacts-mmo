/**
 * Builds routine instances from JSON config entries.
 */
import { RestRoutine } from './rest.mjs';
import { DepositBankRoutine } from './deposit-bank.mjs';
import { BankExpansionRoutine } from './bank-expansion.mjs';
import { SkillRotationRoutine } from './skill-rotation/index.mjs';

const ROUTINE_TYPES = {
  rest:              (cfg) => new RestRoutine({ ...cfg, type: 'rest' }),
  depositBank:       (cfg) => new DepositBankRoutine({ ...cfg, type: 'depositBank' }),
  bankExpansion:     (cfg) => new BankExpansionRoutine({ ...cfg, type: 'bankExpansion' }),
  skillRotation:     (cfg) => new SkillRotationRoutine({ ...cfg, type: 'skillRotation' }),
};

export function buildRoutines(routineConfigs) {
  return routineConfigs.map(cfg => {
    const factory = ROUTINE_TYPES[cfg.type];
    if (!factory) throw new Error(`Unknown routine type: ${cfg.type}`);
    return factory(cfg);
  });
}
