#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BossFightRoutine } from '../src/routines/boss-fight.mjs';
import { _setCachesForTests as setGameDataCachesForTests, _resetForTests as resetGameDataForTests } from '../src/services/game-data.mjs';
import { _resetOrderBoardForTests, createOrMergeOrder, initializeOrderBoard } from '../src/services/order-board.mjs';
import { _resetForTests as resetBossRallyForTests, registerContext, tryCreateRally } from '../src/services/boss-rally.mjs';

function makeCtx(name, { cooldown = 0, full = false } = {}) {
  return {
    name,
    cooldownRemainingMs: () => cooldown,
    inventoryFull: () => full,
    inventoryCount: () => 0,
    inventoryCapacity: () => 100,
    getRoutineKeepCodes: () => ({}),
    setRoutineKeepCodes: () => {},
    get: () => ({ name, level: 30, hp: 500, max_hp: 500 }),
  };
}

async function setupOrderBoard() {
  const tempDir = mkdtempSync(join(tmpdir(), 'boss-fight-routine-'));
  const boardPath = join(tempDir, 'order-board.json');
  _resetOrderBoardForTests();
  await initializeOrderBoard({ path: boardPath });
  return tempDir;
}

function resetSharedState() {
  resetBossRallyForTests();
  _resetOrderBoardForTests();
  resetGameDataForTests();
}

console.log('Test: BossFight canRun skips order-driven routine when no enabled boss has orders');
{
  const tempDir = await setupOrderBoard();
  try {
    resetBossRallyForTests();
    setGameDataCachesForTests({
      monsters: new Map([
        ['king_slime', { code: 'king_slime', drops: [] }],
      ]),
    });

    const leader = makeCtx('Alice');
    const partner = makeCtx('Bob');
    registerContext(leader);
    registerContext(partner);

    const routine = new BossFightRoutine({
      type: 'bossFight',
      orderDriven: true,
      minTeamSize: 2,
      bosses: [{ code: 'king_slime', enabled: true, minWinrate: 80 }],
    });

    assert.equal(routine.canRun(leader), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    resetSharedState();
  }
}
console.log('  PASS');

console.log('Test: BossFight canRun stays runnable when order-driven boss has a matching order');
{
  const tempDir = await setupOrderBoard();
  try {
    resetBossRallyForTests();
    setGameDataCachesForTests({
      monsters: new Map([
        ['king_slime', { code: 'king_slime', drops: [] }],
      ]),
    });

    createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'fight:king_slime',
      itemCode: 'slime_essence',
      sourceType: 'fight',
      sourceCode: 'king_slime',
      sourceLevel: 10,
      quantity: 1,
    });

    const leader = makeCtx('Alice');
    const partner = makeCtx('Bob');
    registerContext(leader);
    registerContext(partner);

    const routine = new BossFightRoutine({
      type: 'bossFight',
      orderDriven: true,
      minTeamSize: 2,
      bosses: [{ code: 'king_slime', enabled: true, minWinrate: 80 }],
    });

    assert.equal(routine.canRun(leader), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    resetSharedState();
  }
}
console.log('  PASS');

console.log('Test: BossFight escalates priority and urgency for active rally participants');
{
  try {
    resetBossRallyForTests();
    const leader = makeCtx('Alice');
    const partner = makeCtx('Bob');
    registerContext(leader);
    registerContext(partner);

    const routine = new BossFightRoutine({
      type: 'bossFight',
      priority: 15,
      bosses: [{ code: 'king_slime', enabled: true, minWinrate: 80 }],
    });

    assert.equal(routine.effectivePriority(leader), 15);
    assert.equal(routine.isUrgent(leader), false);

    tryCreateRally({
      bossCode: 'king_slime',
      location: { x: 1, y: 2 },
      leaderName: 'Alice',
      participants: ['Bob'],
    });

    assert.equal(routine.canRun(leader), true);
    assert.equal(routine.effectivePriority(leader), 95);
    assert.equal(routine.isUrgent(leader), true);
    assert.equal(routine.effectivePriority(partner), 95);
    assert.equal(routine.isUrgent(partner), true);
  } finally {
    resetSharedState();
  }
}
console.log('  PASS');

console.log('test-boss-fight-routine: PASS');
