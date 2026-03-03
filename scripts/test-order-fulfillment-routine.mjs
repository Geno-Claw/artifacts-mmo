#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const {
  _resetOrderBoardForTests: resetOrderBoardForTests,
  claimOrder,
  createOrMergeOrder,
  initializeOrderBoard,
} = await import('../src/services/order-board.mjs');
const { OrderFulfillmentRoutine } = await import('../src/routines/order-fulfillment.mjs');

function makeCtx({
  name = 'Tester',
  skillLevels = {},
  itemCounts = {},
  inventoryFull = false,
} = {}) {
  return {
    name,
    skillLevel(skill) {
      return Number(skillLevels[skill] || 0);
    },
    itemCount(code) {
      return Number(itemCounts[code] || 0);
    },
    inventoryFull() {
      return inventoryFull === true;
    },
    inventoryCount() {
      return 0;
    },
    inventoryCapacity() {
      return 30;
    },
  };
}

async function withTempOrderBoard(testFn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'order-fulfillment-routine-'));
  const boardPath = join(tempDir, 'order-board.json');
  try {
    resetOrderBoardForTests();
    await initializeOrderBoard({ path: boardPath });
    await testFn();
  } finally {
    resetOrderBoardForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeRoutine(overrides = {}) {
  const routine = new OrderFulfillmentRoutine({
    enabled: true,
    orderBoard: {
      enabled: true,
      fulfillOrders: true,
      createOrders: true,
      leaseMs: 120_000,
      blockedRetryMs: 600_000,
    },
    ...overrides,
  });
  routine._getBankItems = async () => new Map();
  return routine;
}

async function testGatherPriority() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx({
      skillLevels: { mining: 20 },
      itemCounts: { tasks_coin: 6 },
    });
    const routine = makeRoutine();

    let gatherCalls = 0;
    let combatCalls = 0;
    let craftCalls = 0;
    let exchangeCalls = 0;

    routine._executeGathering = async () => { gatherCalls += 1; return true; };
    routine._executeCombat = async () => { combatCalls += 1; return true; };
    routine._executeCrafting = async () => { craftCalls += 1; return true; };
    routine._fulfillTaskExchangeOrderClaim = async () => {
      exchangeCalls += 1;
      return { attempted: true, fulfilled: true };
    };

    createOrMergeOrder({
      requesterName: 'ReqA',
      recipeCode: 'gather-prio',
      itemCode: 'gather_item',
      sourceType: 'gather',
      sourceCode: 'ore_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 2,
    });
    createOrMergeOrder({
      requesterName: 'ReqB',
      recipeCode: 'fight-prio',
      itemCode: 'fight_item',
      sourceType: 'fight',
      sourceCode: 'wolf',
      sourceLevel: 10,
      quantity: 2,
    });
    createOrMergeOrder({
      requesterName: 'ReqC',
      recipeCode: 'craft-prio',
      itemCode: 'craft_item',
      sourceType: 'craft',
      sourceCode: 'craft_item',
      craftSkill: 'weaponcrafting',
      sourceLevel: 10,
      quantity: 1,
    });
    createOrMergeOrder({
      requesterName: 'ReqD',
      recipeCode: 'exchange-prio',
      itemCode: 'jasper_crystal',
      sourceType: 'task_exchange',
      sourceCode: 'jasper_crystal',
      quantity: 1,
    });

    const result = await routine.execute(ctx);
    assert.equal(result, true, 'gather execution should run');
    assert.equal(gatherCalls, 1, 'gather should run first');
    assert.equal(combatCalls, 0);
    assert.equal(craftCalls, 0);
    assert.equal(exchangeCalls, 0);
  });
}

async function testFightPriorityWhenNoGather() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx({ itemCounts: { tasks_coin: 6 } });
    const routine = makeRoutine();

    let combatCalls = 0;
    let craftCalls = 0;

    routine._simulateClaimFight = async () => ({ simResult: { win: true, hpLostPercent: 25 } });
    routine._executeCombat = async () => { combatCalls += 1; return true; };
    routine._executeCrafting = async () => { craftCalls += 1; return true; };

    createOrMergeOrder({
      requesterName: 'ReqB',
      recipeCode: 'fight-prio',
      itemCode: 'fight_item',
      sourceType: 'fight',
      sourceCode: 'wolf',
      sourceLevel: 10,
      quantity: 2,
    });
    createOrMergeOrder({
      requesterName: 'ReqC',
      recipeCode: 'craft-prio',
      itemCode: 'craft_item',
      sourceType: 'craft',
      sourceCode: 'craft_item',
      craftSkill: 'weaponcrafting',
      sourceLevel: 10,
      quantity: 1,
    });

    const result = await routine.execute(ctx);
    assert.equal(result, true);
    assert.equal(combatCalls, 1, 'fight should run when no gather claim exists');
    assert.equal(craftCalls, 0);
  });
}

async function testDirectCraftClaim() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx();
    const routine = makeRoutine();

    let craftCalls = 0;
    routine._canClaimCraftOrderNow = async () => ({ ok: true, reason: '' });
    routine._executeCrafting = async () => { craftCalls += 1; return true; };

    createOrMergeOrder({
      requesterName: 'ReqC',
      recipeCode: 'craft-prio',
      itemCode: 'craft_item',
      sourceType: 'craft',
      sourceCode: 'craft_item',
      craftSkill: 'weaponcrafting',
      sourceLevel: 10,
      quantity: 1,
    });

    const result = await routine.execute(ctx);
    assert.equal(result, true);
    assert.equal(craftCalls, 1, 'craft should run when no gather/fight claim exists');
  });
}

async function testCraftExpansionThrottle() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx();
    const routine = makeRoutine({ craftScanLimit: 1 });

    let blockedCalls = 0;
    let queuedGather = 0;
    routine._canClaimCraftOrderNow = async () => ({
      ok: false,
      reason: 'insufficient_gather_skill',
      deficits: [{
        type: 'gather',
        itemCode: 'ash_wood',
        quantity: 2,
        resource: { code: 'ash_tree', skill: 'woodcutting', level: 10 },
      }],
    });
    routine._enqueueGatherOrderForDeficit = () => {
      queuedGather += 1;
    };
    routine._blockUnclaimableOrderForChar = () => {
      blockedCalls += 1;
    };

    createOrMergeOrder({
      requesterName: 'ReqC1',
      recipeCode: 'craft-prio-1',
      itemCode: 'craft_item_1',
      sourceType: 'craft',
      sourceCode: 'craft_item_1',
      craftSkill: 'weaponcrafting',
      sourceLevel: 10,
      quantity: 1,
    });
    createOrMergeOrder({
      requesterName: 'ReqC2',
      recipeCode: 'craft-prio-2',
      itemCode: 'craft_item_2',
      sourceType: 'craft',
      sourceCode: 'craft_item_2',
      craftSkill: 'weaponcrafting',
      sourceLevel: 10,
      quantity: 1,
    });

    const result = await routine.execute(ctx);
    assert.equal(result, false, 'no claim should be executed when craft is blocked');
    assert.equal(queuedGather, 1, 'only one craft order should be expanded per cycle');
    assert.equal(blockedCalls, 1, 'only one craft order should be blocked per cycle');
  });
}

async function testTaskExchangePath() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx({ itemCounts: { tasks_coin: 6 } });
    const routine = makeRoutine();

    let exchangeCalls = 0;
    routine._fulfillTaskExchangeOrderClaim = async () => {
      exchangeCalls += 1;
      return { attempted: true, fulfilled: true };
    };

    createOrMergeOrder({
      requesterName: 'ReqD',
      recipeCode: 'exchange-prio',
      itemCode: 'jasper_crystal',
      sourceType: 'task_exchange',
      sourceCode: 'jasper_crystal',
      quantity: 1,
    });

    const result = await routine.execute(ctx);
    assert.equal(result, true);
    assert.equal(exchangeCalls, 1, 'task_exchange claims should be fulfilled by this routine');
  });
}

async function testClaimAdoption() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx({
      name: 'Tester',
      skillLevels: { mining: 20 },
    });
    const routine = makeRoutine();
    let gatherCalls = 0;
    routine._executeGathering = async () => { gatherCalls += 1; return true; };

    const order = createOrMergeOrder({
      requesterName: 'ReqA',
      recipeCode: 'adopt-gather',
      itemCode: 'adopt_item',
      sourceType: 'gather',
      sourceCode: 'ore_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 2,
    });
    assert.ok(order, 'expected order to be created');
    const claimed = claimOrder(order.id, { charName: 'Tester', leaseMs: 120_000 });
    assert.ok(claimed, 'expected order to be pre-claimed for adoption');

    const result = await routine.execute(ctx);
    assert.equal(result, true);
    assert.equal(gatherCalls, 1, 'routine should adopt and execute pre-existing same-char claim');
  });
}

async function testNoWorkReturnsFalse() {
  await withTempOrderBoard(async () => {
    const ctx = makeCtx();
    const routine = makeRoutine();
    assert.equal(routine.canRun(ctx), false, 'canRun should be false with no orders');
    const result = await routine.execute(ctx);
    assert.equal(result, false, 'execute should return false when no work exists');
  });
}

async function run() {
  await testGatherPriority();
  await testFightPriorityWhenNoGather();
  await testDirectCraftClaim();
  await testCraftExpansionThrottle();
  await testTaskExchangePath();
  await testClaimAdoption();
  await testNoWorkReturnsFalse();
  console.log('test-order-fulfillment-routine: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
