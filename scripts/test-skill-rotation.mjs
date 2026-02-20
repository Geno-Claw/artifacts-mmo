#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { CharacterContext } = await import('../src/context.mjs');
const { SkillRotation } = await import('../src/services/skill-rotation.mjs');
const { SkillRotationRoutine } = await import('../src/routines/skill-rotation/index.mjs');
const orderBoard = await import('../src/services/order-board.mjs');
const orderPriority = await import('../src/services/order-priority.mjs');
const bankOps = await import('../src/services/bank-ops.mjs');
const inventoryManager = await import('../src/services/inventory-manager.mjs');

const {
  _resetOrderBoardForTests: resetOrderBoardForTests,
  createOrMergeOrder,
  getOrderBoardSnapshot,
  initializeOrderBoard,
  listClaimableOrders,
} = orderBoard;

const {
  _setDepsForTests: setOrderPriorityDepsForTests,
  _resetForTests: resetOrderPriorityForTests,
} = orderPriority;

const {
  _setApiClientForTests: setBankOpsApiForTests,
  _resetForTests: resetBankOpsForTests,
} = bankOps;

const {
  getBankItems,
  _setApiClientForTests: setInventoryApiForTests,
  _resetForTests: resetInventoryForTests,
} = inventoryManager;

function makeCtx({ alchemyLevel = 1, skillLevels = {}, itemCounts = {} } = {}) {
  return {
    name: 'Tester',
    skillLevel(skill) {
      if (Object.hasOwn(skillLevels, skill)) return skillLevels[skill];
      if (skill === 'alchemy') return alchemyLevel;
      return 1;
    },
    itemCount(code) {
      return itemCounts[code] || 0;
    },
  };
}

function makeGameDataStub(overrides = {}) {
  return {
    findResourcesBySkill() { return []; },
    async getResourceLocation() { return null; },
    findItems() { return []; },
    async getBankItems() { return new Map(); },
    resolveRecipeChain() { return null; },
    canFulfillPlan() { return false; },
    isTaskReward() { return false; },
    ...overrides,
  };
}

function makeAlchemyRecipe() {
  return {
    code: 'small_health_potion',
    craft: {
      skill: 'alchemy',
      level: 5,
      items: [{ code: 'sunflower', quantity: 3 }],
    },
  };
}

function makeRecipe(code, skill, level) {
  return {
    code,
    craft: {
      skill,
      level,
      items: [],
      _testCode: code,
    },
  };
}

function installOrderPriorityDeps(itemsByCode = new Map()) {
  const equipmentTypes = new Set([
    'weapon',
    'shield',
    'helmet',
    'body_armor',
    'leg_armor',
    'boots',
    'ring',
    'amulet',
    'bag',
  ]);

  setOrderPriorityDepsForTests({
    gameDataSvc: {
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
      isEquipmentType(item) {
        return item != null && equipmentTypes.has(item.type);
      },
    },
  });
}

async function withTempOrderBoard(testFn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'skill-rotation-order-board-'));
  const boardPath = join(tempDir, 'order-board.json');
  try {
    resetOrderBoardForTests();
    await initializeOrderBoard({ path: boardPath });
    await testFn({ boardPath });
  } finally {
    resetOrderBoardForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testAlchemyFallbackToGatherAtLevel1() {
  const resource = { code: 'sunflower_field', skill: 'alchemy', level: 1 };
  const stub = makeGameDataStub({
    findItems: () => [],
    findResourcesBySkill: () => [resource],
    getResourceLocation: async () => ({ x: 2, y: 2 }),
  });

  const rotation = new SkillRotation(
    { weights: { alchemy: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ alchemyLevel: 1 }));
  assert.equal(chosen, 'alchemy');
  assert.equal(rotation.recipe, null);
  assert.equal(rotation.productionPlan, null);
  assert.equal(rotation.resource?.code, 'sunflower_field');
  assert.deepEqual(rotation.resourceLoc, { x: 2, y: 2 });
}

async function testAlchemyCraftingSelectsViableRecipe() {
  const recipe = makeAlchemyRecipe();
  const plan = [
    {
      type: 'gather',
      itemCode: 'sunflower',
      resource: { code: 'sunflower_field', skill: 'alchemy', level: 1 },
      quantity: 3,
    },
  ];
  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'alchemy' && maxLevel >= 5 ? [recipe] : [],
    getBankItems: async () => new Map(),
    resolveRecipeChain: () => plan,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    { weights: { alchemy: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ alchemyLevel: 5 }));
  assert.equal(chosen, 'alchemy');
  assert.equal(rotation.recipe?.code, 'small_health_potion');
  assert.ok(Array.isArray(rotation.productionPlan));
  assert.equal(rotation.resource, null);
}

async function testAlchemyCraftingNonViableFallsBackToGathering() {
  const recipe = makeAlchemyRecipe();
  const gatherFallback = { code: 'sunflower_field', skill: 'alchemy', level: 1 };
  const impossiblePlan = [
    {
      type: 'gather',
      itemCode: 'glowstem_leaf',
      resource: { code: 'glowstem', skill: 'alchemy', level: 40 },
      quantity: 2,
    },
  ];
  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'alchemy' && maxLevel >= 5 ? [recipe] : [],
    resolveRecipeChain: () => impossiblePlan,
    canFulfillPlan: () => false,
    findResourcesBySkill: () => [gatherFallback],
    getResourceLocation: async () => ({ x: 2, y: 2 }),
  });

  const rotation = new SkillRotation(
    { weights: { alchemy: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ alchemyLevel: 5 }));
  assert.equal(chosen, 'alchemy');
  assert.equal(rotation.recipe, null);
  assert.equal(rotation.productionPlan, null);
  assert.equal(rotation.resource?.code, 'sunflower_field');
  assert.deepEqual(rotation.resourceLoc, { x: 2, y: 2 });
}

async function testCraftingXpPrefersBankOnlyRecipe() {
  const lowBankRecipe = makeRecipe('cooked_shrimp', 'cooking', 5);
  const highGatherRecipe = makeRecipe('cooked_bass', 'cooking', 25);
  const planByRecipe = new Map([
    [lowBankRecipe.code, [
      { type: 'bank', itemCode: 'raw_shrimp', quantity: 2 },
    ]],
    [highGatherRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_bass',
        resource: { code: 'bass_fishing_spot', skill: 'fishing', level: 1 },
        quantity: 2,
      },
    ]],
  ]);

  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'cooking' && maxLevel >= 25 ? [highGatherRecipe, lowBankRecipe] : [],
    getBankItems: async () => new Map([['raw_shrimp', 20]]),
    resolveRecipeChain: (craft) => planByRecipe.get(craft._testCode) || null,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    { weights: { cooking: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ skillLevels: { cooking: 25 } }));
  assert.equal(chosen, 'cooking');
  assert.equal(rotation.recipe?.code, 'cooked_shrimp');
}

async function testCraftingXpFallsBackToHighestLevelWhenNoBankOnly() {
  const lowRecipe = makeRecipe('cooked_shrimp', 'cooking', 5);
  const highRecipe = makeRecipe('cooked_bass', 'cooking', 25);
  const planByRecipe = new Map([
    [lowRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_shrimp',
        resource: { code: 'shrimp_fishing_spot', skill: 'fishing', level: 1 },
        quantity: 2,
      },
    ]],
    [highRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_bass',
        resource: { code: 'bass_fishing_spot', skill: 'fishing', level: 1 },
        quantity: 2,
      },
    ]],
  ]);

  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'cooking' && maxLevel >= 25 ? [lowRecipe, highRecipe] : [],
    getBankItems: async () => new Map(),
    resolveRecipeChain: (craft) => planByRecipe.get(craft._testCode) || null,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    { weights: { cooking: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ skillLevels: { cooking: 25 } }));
  assert.equal(chosen, 'cooking');
  assert.equal(rotation.recipe?.code, 'cooked_bass');
}

async function testCraftingSkipsTemporarilyBlockedRecipe() {
  const lowRecipe = makeRecipe('cooked_shrimp', 'cooking', 5);
  const highRecipe = makeRecipe('cooked_bass', 'cooking', 25);
  const planByRecipe = new Map([
    [lowRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_shrimp',
        resource: { code: 'shrimp_fishing_spot', skill: 'fishing', level: 1 },
        quantity: 2,
      },
    ]],
    [highRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_bass',
        resource: { code: 'bass_fishing_spot', skill: 'fishing', level: 1 },
        quantity: 2,
      },
    ]],
  ]);

  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'cooking' && maxLevel >= 25 ? [lowRecipe, highRecipe] : [],
    getBankItems: async () => new Map(),
    resolveRecipeChain: (craft) => planByRecipe.get(craft._testCode) || null,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    { weights: { cooking: 1 } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  rotation.blockRecipe('cooking', 'cooked_bass', { durationMs: 60_000 });
  const chosen = await rotation.pickNext(makeCtx({ skillLevels: { cooking: 25 } }));
  assert.equal(chosen, 'cooking');
  assert.equal(rotation.recipe?.code, 'cooked_shrimp');
}

async function testUnwinnableCombatRecipeIsTemporarilyBlocked() {
  const recipe = makeRecipe('wolf_hat', 'gearcrafting', 20);
  const plan = [{
    type: 'fight',
    itemCode: 'wolf_pelt',
    quantity: 1,
    monster: { code: 'wolf', level: 20 },
  }];
  let optimizeCalls = 0;

  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'gearcrafting' && maxLevel >= 20 ? [recipe] : [],
    getBankItems: async () => new Map(),
    resolveRecipeChain: () => plan,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    { weights: { gearcrafting: 1 } },
    {
      gameDataSvc: stub,
      findBestCombatTargetFn: async () => null,
      optimizeForMonsterFn: async () => {
        optimizeCalls += 1;
        return { simResult: { win: false, hpLostPercent: 100 } };
      },
    },
  );

  const ctx = makeCtx({ skillLevels: { gearcrafting: 20 } });
  const first = await rotation.pickNext(ctx);
  const second = await rotation.pickNext(ctx);

  assert.equal(first, null, 'first pass should reject the unwinnable recipe');
  assert.equal(second, null, 'second pass should skip the blocked recipe');
  assert.equal(optimizeCalls, 1, 'unwinnable recipe should be blocked and not re-simulated immediately');
}

async function testOrderBoardCreatesGatherOrderForUnmetGatherSkill() {
  const recipe = makeRecipe('hard_steel_blade', 'weaponcrafting', 30);
  const plan = [
    {
      type: 'gather',
      itemCode: 'hard_ore',
      resource: { code: 'hard_rocks', skill: 'mining', level: 40 },
      quantity: 3,
    },
  ];
  const createdOrders = [];

  const stub = makeGameDataStub({
    resolveRecipeChain: () => plan,
    canFulfillPlan: () => false,
  });

  const rotation = new SkillRotation(
    { weights: { weaponcrafting: 1 }, orderBoard: { enabled: true } },
    {
      gameDataSvc: stub,
      findBestCombatTargetFn: async () => null,
      createOrMergeOrderFn: (payload) => {
        createdOrders.push(payload);
        return payload;
      },
    },
  );

  const candidate = rotation._buildCraftCandidate(
    recipe,
    makeCtx({ skillLevels: { mining: 5 }, itemCounts: {} }),
    new Map(),
  );
  assert.equal(candidate, null, 'recipe should be rejected when gather skill is too low');
  assert.equal(createdOrders.length, 1, 'a gather order should be created');
  assert.equal(createdOrders[0].sourceType, 'gather');
  assert.equal(createdOrders[0].sourceCode, 'hard_rocks');
  assert.equal(createdOrders[0].itemCode, 'hard_ore');
  assert.equal(createdOrders[0].quantity, 3);
}

async function testOrderBoardCanDisableOrderCreation() {
  const recipe = makeRecipe('hard_steel_blade', 'weaponcrafting', 30);
  const plan = [
    {
      type: 'gather',
      itemCode: 'hard_ore',
      resource: { code: 'hard_rocks', skill: 'mining', level: 40 },
      quantity: 3,
    },
  ];
  const createdOrders = [];

  const stub = makeGameDataStub({
    resolveRecipeChain: () => plan,
    canFulfillPlan: () => false,
  });

  const rotation = new SkillRotation(
    { weights: { weaponcrafting: 1 }, orderBoard: { enabled: true, createOrders: false } },
    {
      gameDataSvc: stub,
      findBestCombatTargetFn: async () => null,
      createOrMergeOrderFn: (payload) => {
        createdOrders.push(payload);
        return payload;
      },
    },
  );

  const candidate = rotation._buildCraftCandidate(
    recipe,
    makeCtx({ skillLevels: { mining: 5 }, itemCounts: {} }),
    new Map(),
  );
  assert.equal(candidate, null, 'recipe should still be rejected when gather skill is too low');
  assert.equal(createdOrders.length, 0, 'order creation should be skipped when createOrders is false');
}

async function testOrderBoardCreatesFightOrderForUnwinnableMonsterDrop() {
  const createdOrders = [];
  const recipe = makeRecipe('wolf_hat', 'gearcrafting', 20);

  const rotation = new SkillRotation(
    { weights: { gearcrafting: 1 }, orderBoard: { enabled: true } },
    {
      gameDataSvc: makeGameDataStub(),
      findBestCombatTargetFn: async () => null,
      optimizeForMonsterFn: async () => ({ simResult: { win: false, hpLostPercent: 100 } }),
      createOrMergeOrderFn: (payload) => {
        createdOrders.push(payload);
        return payload;
      },
    },
  );

  const verified = await rotation._verifyCombatViability([{
    recipe,
    needsCombat: true,
    fightSteps: [{
      itemCode: 'wolf_pelt',
      monster: { code: 'wolf', level: 20 },
      deficit: 2,
    }],
  }], makeCtx());

  assert.equal(verified.length, 0, 'unwinnable combat candidate should be rejected');
  assert.equal(createdOrders.length, 1, 'a fight order should be created');
  assert.equal(createdOrders[0].sourceType, 'fight');
  assert.equal(createdOrders[0].sourceCode, 'wolf');
  assert.equal(createdOrders[0].itemCode, 'wolf_pelt');
  assert.equal(createdOrders[0].quantity, 2);
}

async function testAcquireCraftClaimSkipsUnwinnableFightAndBlocksChar() {
  await withTempOrderBoard(async () => {
    const routine = new SkillRotationRoutine({
      orderBoard: {
        enabled: true,
        fulfillOrders: true,
      },
    });

    const created = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'cheese',
      itemCode: 'cheese',
      sourceType: 'craft',
      sourceCode: 'cheese',
      craftSkill: 'alchemy',
      sourceLevel: 1,
      quantity: 1,
    });
    assert.ok(created, 'expected craft order to be created');

    routine._getBankItems = async () => new Map();
    routine._getCraftClaimItem = () => ({
      code: 'cheese',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveRecipeChain = () => [
      {
        type: 'fight',
        itemCode: 'milk_bucket',
        quantity: 1,
        monster: { code: 'cow', level: 8 },
      },
    ];
    routine._canFulfillCraftClaimPlan = () => true;
    let simCalls = 0;
    routine._simulateClaimFight = async () => {
      simCalls += 1;
      return { simResult: { win: false, hpLostPercent: 100 } };
    };

    const claim = await routine._acquireCraftOrderClaim(
      makeCtx({ skillLevels: { alchemy: 10 } }),
      'alchemy',
    );

    assert.equal(claim, null, 'unwinnable craft claim should be skipped');
    assert.equal(simCalls, 1, 'fight simulation should run once for required fight step');
    assert.equal(
      listClaimableOrders({ sourceType: 'craft', craftSkill: 'alchemy', charName: 'Tester' }).length,
      0,
      'skipped order should be blocked for this character',
    );

    const snapshot = getOrderBoardSnapshot();
    const blockedUntil = Number(snapshot.orders[0]?.blockedByChar?.Tester || 0);
    assert.ok(blockedUntil > Date.now(), 'blocked retry timestamp should be set for char');
  });
}

async function testAcquireCraftClaimSkipsMissingBankDependencyAndBlocksChar() {
  await withTempOrderBoard(async () => {
    const routine = new SkillRotationRoutine({
      orderBoard: {
        enabled: true,
        fulfillOrders: true,
      },
    });

    const created = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'rare_potion',
      itemCode: 'rare_potion',
      sourceType: 'craft',
      sourceCode: 'rare_potion',
      craftSkill: 'alchemy',
      sourceLevel: 5,
      quantity: 1,
    });
    assert.ok(created, 'expected craft order to be created');

    routine._getBankItems = async () => new Map();
    routine._getCraftClaimItem = () => ({
      code: 'rare_potion',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveRecipeChain = () => [
      { type: 'bank', itemCode: 'event_core', quantity: 1 },
    ];
    routine._canFulfillCraftClaimPlan = () => true;
    let simCalls = 0;
    routine._simulateClaimFight = async () => {
      simCalls += 1;
      return { simResult: { win: true, hpLostPercent: 20 } };
    };
    routine._isTaskRewardCode = () => false;
    let proactiveCalls = 0;
    routine._maybeRunProactiveExchange = async () => {
      proactiveCalls += 1;
      return { attempted: false, exchanged: 0, resolved: false, reason: 'deferred' };
    };

    const claim = await routine._acquireCraftOrderClaim(
      makeCtx({ skillLevels: { alchemy: 10 } }),
      'alchemy',
    );

    assert.equal(claim, null, 'claim should be skipped when bank dependency is missing');
    assert.equal(simCalls, 0, 'fight simulation should not run when bank step already fails');
    assert.equal(proactiveCalls, 0, 'non-task reward bank dependency should not trigger proactive exchange');
    assert.equal(
      listClaimableOrders({ sourceType: 'craft', craftSkill: 'alchemy', charName: 'Tester' }).length,
      0,
      'skipped order should be blocked for this character',
    );
  });
}

async function testAcquireCraftClaimRetriesTaskRewardDependencyWithProactiveExchange() {
  await withTempOrderBoard(async () => {
    const routine = new SkillRotationRoutine({
      orderBoard: {
        enabled: true,
        fulfillOrders: true,
      },
    });

    const created = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'satchel',
      itemCode: 'satchel',
      sourceType: 'craft',
      sourceCode: 'satchel',
      craftSkill: 'gearcrafting',
      sourceLevel: 5,
      quantity: 1,
    });
    assert.ok(created, 'expected craft order to be created');

    let bankState = new Map();
    routine._getBankItems = async () => bankState;
    routine._canClaimCraftOrderNow = async (_ctx, _order, _craftSkill, bank) => {
      const hasJasper = (bank.get('jasper_crystal') || 0) >= 1;
      if (!hasJasper) {
        return { ok: false, reason: 'missing_bank_dependency:jasper_crystal' };
      }
      return { ok: true, reason: '' };
    };
    routine._isTaskRewardCode = (code) => code === 'jasper_crystal';

    let proactiveCalls = 0;
    routine._maybeRunProactiveExchange = async () => {
      proactiveCalls += 1;
      bankState = new Map([['jasper_crystal', 1]]);
      return { attempted: true, exchanged: 1, resolved: true, reason: 'targets_met' };
    };

    const claim = await routine._acquireCraftOrderClaim(
      makeCtx({ skillLevels: { gearcrafting: 10 } }),
      'gearcrafting',
    );

    assert.ok(claim, 'claim should succeed after proactive exchange satisfies missing task reward');
    assert.equal(proactiveCalls, 1, 'proactive exchange should run once for missing task reward dependency');
  });
}

async function testAcquireCraftClaimSucceedsWhenPrechecksPass() {
  await withTempOrderBoard(async () => {
    const routine = new SkillRotationRoutine({
      orderBoard: {
        enabled: true,
        fulfillOrders: true,
      },
    });

    const created = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'fang_elixir',
      itemCode: 'fang_elixir',
      sourceType: 'craft',
      sourceCode: 'fang_elixir',
      craftSkill: 'alchemy',
      sourceLevel: 5,
      quantity: 1,
    });
    assert.ok(created, 'expected craft order to be created');

    routine._getBankItems = async () => new Map([['empty_vial', 1]]);
    routine._getCraftClaimItem = () => ({
      code: 'fang_elixir',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveRecipeChain = () => [
      {
        type: 'gather',
        itemCode: 'herb',
        quantity: 1,
        resource: { code: 'herb_patch', skill: 'alchemy', level: 1 },
      },
      { type: 'bank', itemCode: 'empty_vial', quantity: 1 },
      {
        type: 'fight',
        itemCode: 'wolf_fang',
        quantity: 1,
        monster: { code: 'wolf', level: 5 },
      },
    ];
    routine._canFulfillCraftClaimPlan = () => true;
    routine._simulateClaimFight = async () => ({ simResult: { win: true, hpLostPercent: 40 } });

    const claim = await routine._acquireCraftOrderClaim(
      makeCtx({ skillLevels: { alchemy: 10 } }),
      'alchemy',
    );

    assert.ok(claim, 'precheck-passing craft order should be claimed');
    assert.equal(claim?.sourceType, 'craft');
    assert.equal(claim?.craftSkill, 'alchemy');
  });
}

async function testAcquireGatherClaimPrioritizesToolOrders() {
  await withTempOrderBoard(async () => {
    installOrderPriorityDeps(new Map([
      ['priority_tool', { code: 'priority_tool', type: 'weapon', subtype: 'tool' }],
      ['priority_resource', { code: 'priority_resource', type: 'resource' }],
      ['priority_weapon', { code: 'priority_weapon', type: 'weapon' }],
      ['priority_gear', { code: 'priority_gear', type: 'ring' }],
    ]));

    try {
      const routine = new SkillRotationRoutine({
        orderBoard: {
          enabled: true,
          fulfillOrders: true,
        },
      });
      routine.rotation = { currentSkill: 'mining' };

      // Reverse of desired priority to verify sorting is applied.
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'r1',
        itemCode: 'priority_gear',
        sourceType: 'gather',
        sourceCode: 'rocks_gear',
        gatherSkill: 'mining',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'r2',
        itemCode: 'priority_weapon',
        sourceType: 'gather',
        sourceCode: 'rocks_weapon',
        gatherSkill: 'mining',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'r3',
        itemCode: 'priority_resource',
        sourceType: 'gather',
        sourceCode: 'rocks_resource',
        gatherSkill: 'mining',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'r4',
        itemCode: 'priority_tool',
        sourceType: 'gather',
        sourceCode: 'rocks_tool',
        gatherSkill: 'mining',
        sourceLevel: 1,
        quantity: 1,
      });

      const claim = await routine._acquireGatherOrderClaim({ name: 'Tester' });
      assert.equal(claim?.itemCode, 'priority_tool', 'gather claim should prioritize tool orders first');
    } finally {
      resetOrderPriorityForTests();
    }
  });
}

async function testAcquireCombatClaimPrioritizesToolOrders() {
  await withTempOrderBoard(async () => {
    installOrderPriorityDeps(new Map([
      ['fight_tool', { code: 'fight_tool', type: 'weapon', subtype: 'tool' }],
      ['fight_resource', { code: 'fight_resource', type: 'resource' }],
      ['fight_weapon', { code: 'fight_weapon', type: 'weapon' }],
      ['fight_gear', { code: 'fight_gear', type: 'helmet' }],
    ]));

    try {
      const routine = new SkillRotationRoutine({
        orderBoard: {
          enabled: true,
          fulfillOrders: true,
        },
      });
      routine._simulateClaimFight = async () => ({ simResult: { win: true, hpLostPercent: 5 } });

      // Reverse of desired priority to verify sorting is applied.
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'c1',
        itemCode: 'fight_gear',
        sourceType: 'fight',
        sourceCode: 'rat_gear',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'c2',
        itemCode: 'fight_weapon',
        sourceType: 'fight',
        sourceCode: 'rat_weapon',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'c3',
        itemCode: 'fight_resource',
        sourceType: 'fight',
        sourceCode: 'rat_resource',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'c4',
        itemCode: 'fight_tool',
        sourceType: 'fight',
        sourceCode: 'rat_tool',
        sourceLevel: 1,
        quantity: 1,
      });

      const claim = await routine._acquireCombatOrderClaim({ name: 'Tester' });
      assert.equal(claim?.itemCode, 'fight_tool', 'combat claim should prioritize tool orders first');
    } finally {
      resetOrderPriorityForTests();
    }
  });
}

async function testAcquireCraftClaimPrioritizesToolOrders() {
  await withTempOrderBoard(async () => {
    installOrderPriorityDeps(new Map([
      ['craft_tool', { code: 'craft_tool', type: 'weapon', subtype: 'tool' }],
      ['craft_resource', { code: 'craft_resource', type: 'resource' }],
      ['craft_weapon', { code: 'craft_weapon', type: 'weapon' }],
      ['craft_gear', { code: 'craft_gear', type: 'body_armor' }],
    ]));

    try {
      const routine = new SkillRotationRoutine({
        orderBoard: {
          enabled: true,
          fulfillOrders: true,
        },
      });
      routine._getBankItems = async () => new Map();
      routine._canClaimCraftOrderNow = async () => ({ ok: true, reason: '' });

      // Reverse of desired priority to verify sorting is applied.
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'k1',
        itemCode: 'craft_gear',
        sourceType: 'craft',
        sourceCode: 'craft_gear',
        craftSkill: 'alchemy',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'k2',
        itemCode: 'craft_weapon',
        sourceType: 'craft',
        sourceCode: 'craft_weapon',
        craftSkill: 'alchemy',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'k3',
        itemCode: 'craft_resource',
        sourceType: 'craft',
        sourceCode: 'craft_resource',
        craftSkill: 'alchemy',
        sourceLevel: 1,
        quantity: 1,
      });
      createOrMergeOrder({
        requesterName: 'CrafterA',
        recipeCode: 'k4',
        itemCode: 'craft_tool',
        sourceType: 'craft',
        sourceCode: 'craft_tool',
        craftSkill: 'alchemy',
        sourceLevel: 1,
        quantity: 1,
      });

      const claim = await routine._acquireCraftOrderClaim(
        makeCtx({ skillLevels: { alchemy: 10 } }),
        'alchemy',
      );
      assert.equal(claim?.itemCode, 'craft_tool', 'craft claim should prioritize tool orders first');
    } finally {
      resetOrderPriorityForTests();
    }
  });
}

async function testCraftFightStepSkipsCombatWhenSimUnwinnable() {
  const routine = new SkillRotationRoutine();
  routine._ensureOrderClaim = async () => null;
  routine.rotation = {
    currentSkill: 'alchemy',
    goalTarget: 10,
    goalProgress: 0,
    recipe: { code: 'cheese', craft: { skill: 'alchemy', level: 1, items: [] } },
    productionPlan: [{
      type: 'fight',
      itemCode: 'milk_bucket',
      quantity: 1,
      monster: { code: 'cow', level: 8 },
      monsterLoc: { x: 2, y: 2 },
    }],
    bankChecked: true,
    forceRotate: async () => null,
    blockCurrentRecipe: () => true,
  };

  let handledArgs = null;
  routine._equipForCraftFight = async () => ({ simResult: { win: false, hpLostPercent: 100 } });
  routine._handleUnwinnableCraftFight = async (_ctx, args) => {
    handledArgs = args;
    return true;
  };

  const result = await routine._executeCrafting({
    name: 'Tester',
    itemCount: () => 0,
    inventoryCount: () => 1,
    inventoryCapacity: () => 20,
    inventoryFull: () => false,
  });

  assert.equal(result, true);
  assert.ok(handledArgs, 'unwinnable handler should be called');
  assert.equal(handledArgs.monsterCode, 'cow');
  assert.equal(handledArgs.itemCode, 'milk_bucket');
}

async function testHandleUnwinnableCraftFightBlocksRecipeAndRotates() {
  const routine = new SkillRotationRoutine();
  let blockCalls = 0;
  let rotateCalls = 0;
  let claimBlockCalls = 0;

  routine.rotation = {
    currentSkill: 'alchemy',
    blockCurrentRecipe: () => {
      blockCalls += 1;
      return true;
    },
    forceRotate: async () => {
      rotateCalls += 1;
      return null;
    },
  };
  routine._blockAndReleaseClaim = async () => {
    claimBlockCalls += 1;
  };

  const result = await routine._handleUnwinnableCraftFight(
    { name: 'Tester' },
    {
      monsterCode: 'cow',
      itemCode: 'milk_bucket',
      recipeCode: 'cheese',
      claimMode: false,
      simResult: { win: false, hpLostPercent: 100 },
    },
  );

  assert.equal(result, true);
  assert.equal(blockCalls, 1, 'recipe should be blocked for non-claim crafting');
  assert.equal(rotateCalls, 1, 'non-claim path should rotate away');
  assert.equal(claimBlockCalls, 0, 'non-claim path should not block/release a claim');
}

async function testHandleUnwinnableCraftFightBlocksAndReleasesClaim() {
  const routine = new SkillRotationRoutine();
  let blockCalls = 0;
  let rotateCalls = 0;
  let claimReason = null;

  routine.rotation = {
    currentSkill: 'alchemy',
    blockCurrentRecipe: () => {
      blockCalls += 1;
      return true;
    },
    forceRotate: async () => {
      rotateCalls += 1;
      return null;
    },
  };
  routine._blockAndReleaseClaim = async (_ctx, reason) => {
    claimReason = reason;
  };

  const result = await routine._handleUnwinnableCraftFight(
    { name: 'Tester' },
    {
      monsterCode: 'cow',
      itemCode: 'milk_bucket',
      recipeCode: 'cheese',
      claimMode: true,
      simResult: { win: false, hpLostPercent: 100 },
    },
  );

  assert.equal(result, true);
  assert.equal(claimReason, 'combat_not_viable', 'claim mode should block and release claim');
  assert.equal(blockCalls, 0, 'claim mode should not block recipe');
  assert.equal(rotateCalls, 0, 'claim mode should not rotate');
}

async function testCraftFightReadyFalseWithClaimBlocksAndReleasesClaim() {
  const routine = new SkillRotationRoutine();
  routine._ensureOrderClaim = async () => ({
    orderId: 'order-99',
    charName: 'Tester',
    itemCode: 'cheese',
    sourceType: 'craft',
    sourceCode: 'cheese',
    craftSkill: 'alchemy',
    remainingQty: 5,
    claim: {},
  });
  routine._getCraftClaimItem = () => ({
    code: 'cheese',
    craft: { skill: 'alchemy', level: 1, items: [] },
  });
  routine._resolveRecipeChain = () => [{
    type: 'fight',
    itemCode: 'milk_bucket',
    quantity: 1,
    monster: { code: 'cow', level: 8 },
    monsterLoc: { x: 2, y: 2 },
  }];
  routine.rotation = {
    currentSkill: 'alchemy',
    goalTarget: 10,
    goalProgress: 0,
    recipe: { code: 'cheese', craft: { skill: 'alchemy', level: 1, items: [] } },
    productionPlan: [{
      type: 'fight',
      itemCode: 'milk_bucket',
      quantity: 1,
      monster: { code: 'cow', level: 8 },
      monsterLoc: { x: 2, y: 2 },
    }],
    bankChecked: true,
    forceRotate: async () => null,
    blockCurrentRecipe: () => true,
  };

  routine._equipForCraftFight = async () => ({ simResult: null, ready: false });

  let blockReason = null;
  routine._blockAndReleaseClaim = async (_ctx, reason) => {
    blockReason = reason;
  };

  const result = await routine._executeCrafting({
    name: 'Tester',
    itemCount: () => 0,
    inventoryCount: () => 1,
    inventoryCapacity: () => 20,
    inventoryFull: () => false,
    skillLevel: () => 10,
  });

  assert.equal(result, true, 'should return true to avoid tight retry');
  assert.equal(blockReason, 'combat_gear_not_ready:cow', 'should block claim with monster code');
}

async function testCraftFightReadyFalseWithoutClaimBlocksRecipeAndRotates() {
  const routine = new SkillRotationRoutine();
  routine._ensureOrderClaim = async () => null;
  let blockCalls = 0;
  let rotateCalls = 0;
  let blockArgs = null;

  routine.rotation = {
    currentSkill: 'alchemy',
    goalTarget: 10,
    goalProgress: 0,
    recipe: { code: 'cheese', craft: { skill: 'alchemy', level: 1, items: [] } },
    productionPlan: [{
      type: 'fight',
      itemCode: 'milk_bucket',
      quantity: 1,
      monster: { code: 'cow', level: 8 },
      monsterLoc: { x: 2, y: 2 },
    }],
    bankChecked: true,
    blockCurrentRecipe: (args) => {
      blockCalls += 1;
      blockArgs = args;
      return true;
    },
    forceRotate: async () => {
      rotateCalls += 1;
      return null;
    },
  };

  routine._equipForCraftFight = async () => ({ simResult: null, ready: false });

  const result = await routine._executeCrafting({
    name: 'Tester',
    itemCount: () => 0,
    inventoryCount: () => 1,
    inventoryCapacity: () => 20,
    inventoryFull: () => false,
  });

  assert.equal(result, true, 'should return true to avoid tight retry');
  assert.equal(blockCalls, 1, 'should block current recipe');
  assert.ok(blockArgs?.reason?.includes('cow'), 'block reason should mention monster code');
  assert.equal(rotateCalls, 1, 'should force rotate to next recipe');
}

async function testRoutineCanDisableOrderFulfillment() {
  const routine = new SkillRotationRoutine({
    orderBoard: {
      enabled: true,
      fulfillOrders: false,
    },
  });

  const claim = await routine._ensureOrderClaim({ name: 'Tester' }, 'gather');
  assert.equal(claim, null, 'routine should not claim orders when fulfillOrders is false');
}

async function testRoutineRoutesCraftClaimsBySkill() {
  const routine = new SkillRotationRoutine({
    orderBoard: {
      enabled: true,
      fulfillOrders: true,
    },
  });

  let called = 0;
  routine._syncActiveClaimFromBoard = () => null;
  routine._acquireCraftOrderClaim = async (_ctx, skill) => {
    called += 1;
    return { sourceType: 'craft', craftSkill: skill };
  };

  const claim = await routine._ensureOrderClaim(
    { name: 'Tester' },
    'craft',
    { craftSkill: 'gearcrafting' },
  );
  assert.equal(called, 1, 'craft source should use craft-claim acquisition path');
  assert.equal(claim?.craftSkill, 'gearcrafting');
}

async function testRoutineCraftingFallsBackWhenNoCraftClaim() {
  const routine = new SkillRotationRoutine({
    orderBoard: {
      enabled: true,
      fulfillOrders: true,
    },
  });

  let craftingCalls = 0;
  routine._executeCrafting = async () => {
    craftingCalls += 1;
    return true;
  };
  routine.rotation = {
    currentSkill: 'gearcrafting',
    goalTarget: 5,
    goalProgress: 0,
    recipe: { code: 'training_blade' },
    productionPlan: [{ type: 'craft', itemCode: 'training_blade', quantity: 1 }],
    isGoalComplete: () => false,
    pickNext: async () => null,
    forceRotate: async () => null,
  };

  await routine.execute({
    name: 'Tester',
    inventoryFull: () => false,
  });
  assert.equal(craftingCalls, 1, 'crafting mode should continue even when no craft order claim is available');
}

async function testRoutineSkipsGoalProgressWhileOrderClaimIsActive() {
  const routine = new SkillRotationRoutine();
  let progress = 0;
  routine.rotation = {
    recordProgress: (n) => { progress += n; },
  };

  routine._activeOrderClaim = {
    orderId: 'order-1',
    sourceType: 'gather',
    itemCode: 'copper_ore',
  };

  const progressedWithClaim = routine._recordProgress(3);
  assert.equal(progressedWithClaim, false, 'normal goal progress should be skipped while order claim is active');
  assert.equal(progress, 0);

  routine._activeOrderClaim = null;
  const progressedAfterClaim = routine._recordProgress(2);
  assert.equal(progressedAfterClaim, true, 'normal goal progress should resume once claim is cleared');
  assert.equal(progress, 2);
}

function makeRoutineWithAlchemyState(state) {
  const routine = new SkillRotationRoutine();
  let gatherCalls = 0;
  let craftCalls = 0;
  let rotateCalls = 0;

  routine._executeGathering = async () => { gatherCalls += 1; return true; };
  routine._executeCrafting = async () => { craftCalls += 1; return true; };
  routine.rotation = {
    currentSkill: 'alchemy',
    goalTarget: 10,
    goalProgress: 0,
    recipe: null,
    productionPlan: null,
    resource: null,
    resourceLoc: null,
    isGoalComplete: () => false,
    pickNext: async () => null,
    forceRotate: async () => { rotateCalls += 1; return null; },
    ...state,
  };

  return {
    routine,
    gatherCalls: () => gatherCalls,
    craftCalls: () => craftCalls,
    rotateCalls: () => rotateCalls,
  };
}

async function testRoutineDispatchesAlchemyGatheringMode() {
  const harness = makeRoutineWithAlchemyState({
    resource: { code: 'sunflower_field', skill: 'alchemy', level: 1 },
    resourceLoc: { x: 2, y: 2 },
  });

  await harness.routine.execute({ name: 'Tester' });
  assert.equal(harness.gatherCalls(), 1);
  assert.equal(harness.craftCalls(), 0);
  assert.equal(harness.rotateCalls(), 0);
}

async function testRoutineDispatchesAlchemyCraftingMode() {
  const harness = makeRoutineWithAlchemyState({
    recipe: makeAlchemyRecipe(),
    productionPlan: [{ type: 'gather', itemCode: 'sunflower', quantity: 3 }],
  });

  await harness.routine.execute({ name: 'Tester' });
  assert.equal(harness.gatherCalls(), 0);
  assert.equal(harness.craftCalls(), 1);
  assert.equal(harness.rotateCalls(), 0);
}

async function testBatchSizeRespectsInventoryReserve() {
  const routine = new SkillRotationRoutine();
  routine.rotation = {
    goalTarget: 50,
    goalProgress: 0,
    productionPlan: [
      { type: 'gather', itemCode: 'ash_wood', quantity: 10 },
    ],
  };

  const batchSize = routine._batchSize({
    inventoryCapacity: () => 120,
    inventoryCount: () => 7,
  });

  assert.equal(
    batchSize,
    10,
    'batch size should use reserve-aware usable space (101 usable / 10 mats per craft)',
  );
}

async function testItemTaskTradeDecisionDefersBelowBatchWhenGatherable() {
  const routine = new SkillRotationRoutine();
  const decision = routine._shouldTradeItemTaskNow(
    { inventoryFull: () => false },
    { haveQty: 3, needed: 20, canGatherNow: true, usableSpace: 50 },
  );
  assert.equal(decision.tradeNow, false, 'below batch target should continue gathering');
  assert.equal(decision.batchTarget, 20);
}

async function testItemTaskTradeDecisionTradesAtBatchTarget() {
  const routine = new SkillRotationRoutine();
  const decision = routine._shouldTradeItemTaskNow(
    { inventoryFull: () => false },
    { haveQty: 4, needed: 20, canGatherNow: true, usableSpace: 0 },
  );
  assert.equal(decision.tradeNow, true, 'no usable space left should trade');
  assert.equal(decision.batchTarget, 4);
}

async function testItemTaskTradeDecisionTradesWhenInventoryFull() {
  const routine = new SkillRotationRoutine();
  const decision = routine._shouldTradeItemTaskNow(
    { inventoryFull: () => true },
    { haveQty: 1, needed: 20, canGatherNow: true },
  );
  assert.equal(decision.tradeNow, true, 'full inventory with task items should trade immediately');
}

async function testItemTaskTradeDecisionTradesWhenNotGatherable() {
  const routine = new SkillRotationRoutine();
  const decision = routine._shouldTradeItemTaskNow(
    { inventoryFull: () => false },
    { haveQty: 1, needed: 20, canGatherNow: false },
  );
  assert.equal(decision.tradeNow, true, 'non-gatherable path should trade immediately when items exist');
}

function makeItemTaskFlowCtx(state, { task = 'sunflower', taskTotal = 20, taskProgress = 0, gatherLevel = 10 } = {}) {
  return {
    name: 'Tester',
    hasTask: () => true,
    taskComplete: () => false,
    get: () => ({
      task,
      task_total: taskTotal,
      task_progress: taskProgress,
    }),
    itemCount: () => state.haveQty,
    inventoryFull: () => false,
    skillLevel: () => gatherLevel,
    refresh: async () => {},
  };
}

async function testItemTaskFlowDefersTradeUntilBatchWhenGatherable() {
  const routine = new SkillRotationRoutine();
  const state = { haveQty: 1 };
  const trades = [];
  let gatherCalls = 0;

  routine._getItemTaskItem = () => ({ code: 'sunflower', craft: null });
  routine._getItemTaskResource = () => ({ code: 'sunflower_field', skill: 'woodcutting', level: 1 });
  routine._withdrawForItemTask = async () => 0;
  routine._usableInventorySpace = () => 50;
  routine._tradeItemTask = async (_ctx, _itemCode, quantity) => {
    trades.push(quantity);
    return true;
  };
  routine._gatherForItemTask = async () => {
    gatherCalls += 1;
    return true;
  };

  const result = await routine._runItemTaskFlow(makeItemTaskFlowCtx(state));
  assert.equal(result, true);
  assert.equal(gatherCalls, 1, 'below batch threshold should continue gathering');
  assert.deepEqual(trades, [], 'below batch threshold should not trade');
}

async function testItemTaskFlowTradesAtBatchThresholdWhenGatherable() {
  const routine = new SkillRotationRoutine();
  const state = { haveQty: 4 };
  const trades = [];
  let gatherCalls = 0;

  routine._getItemTaskItem = () => ({ code: 'sunflower', craft: null });
  routine._getItemTaskResource = () => ({ code: 'sunflower_field', skill: 'woodcutting', level: 1 });
  routine._withdrawForItemTask = async () => 0;
  routine._usableInventorySpace = () => 0;
  routine._tradeItemTask = async (_ctx, _itemCode, quantity) => {
    trades.push(quantity);
    return true;
  };
  routine._gatherForItemTask = async () => {
    gatherCalls += 1;
    return true;
  };

  const result = await routine._runItemTaskFlow(makeItemTaskFlowCtx(state));
  assert.equal(result, true);
  assert.equal(gatherCalls, 0, 'at batch threshold should trade instead of gathering');
  assert.deepEqual(trades, [4], 'trade quantity should match available task item count');
}

async function testItemTaskFlowTradesImmediatelyAfterBankWithdraw() {
  const routine = new SkillRotationRoutine();
  const state = { haveQty: 1 };
  const trades = [];
  let gatherCalls = 0;

  routine._getItemTaskItem = () => ({ code: 'sunflower', craft: null });
  routine._getItemTaskResource = () => ({ code: 'sunflower_field', skill: 'woodcutting', level: 1 });
  routine._withdrawForItemTask = async () => {
    state.haveQty += 2;
    return 2;
  };
  routine._tradeItemTask = async (_ctx, _itemCode, quantity) => {
    trades.push(quantity);
    return true;
  };
  routine._gatherForItemTask = async () => {
    gatherCalls += 1;
    return true;
  };

  const result = await routine._runItemTaskFlow(makeItemTaskFlowCtx(state));
  assert.equal(result, true);
  assert.equal(gatherCalls, 0, 'fresh bank withdrawal should trade immediately');
  assert.deepEqual(trades, [3], 'trade should use post-withdraw inventory quantity');
}

async function testItemTaskWithdrawRespectsReserveCap() {
  const state = {
    bank: new Map([
      ['ash_wood', 200],
    ]),
    withdrawCalls: [],
  };

  const fakeApi = {
    async getBankItems({ page }) {
      if (page > 1) return [];
      return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
    },
    async move() {
      return {};
    },
    async waitForCooldown() {},
    async withdrawBank(items) {
      for (const entry of items) {
        const code = entry?.code;
        const qty = Number(entry?.quantity) || 0;
        if (!code || qty <= 0) continue;
        const have = state.bank.get(code) || 0;
        if (have < qty) throw new Error(`not enough ${code}`);
        const next = have - qty;
        if (next > 0) state.bank.set(code, next);
        else state.bank.delete(code);
        state.withdrawCalls.push({ code, quantity: qty });
      }
      return {};
    },
  };

  resetInventoryForTests();
  resetBankOpsForTests();
  setInventoryApiForTests(fakeApi);
  setBankOpsApiForTests(fakeApi);

  try {
    await getBankItems(true);

    const routine = new SkillRotationRoutine();
    const ctx = {
      name: 'Tester',
      isAt: () => true,
      inventoryCapacity: () => 120,
      inventoryCount: () => 105,
      itemCount: () => 0,
      refresh: async () => {},
    };

    const withdrawn = await routine._withdrawForItemTask(ctx, 'ash_wood', 50);
    assert.equal(withdrawn, 3, 'withdraw should be capped by reserve-aware usable space');
    assert.deepEqual(state.withdrawCalls, [{ code: 'ash_wood', quantity: 3 }]);
  } finally {
    resetInventoryForTests();
    resetBankOpsForTests();
  }
}

async function testItemTaskReserveOverflowUsesCraftTradeFallback() {
  const routine = new SkillRotationRoutine();
  let fallbackCalls = 0;

  routine._withdrawForItemTask = async () => 0;
  routine._craftAndTradeItemTaskFromInventory = async () => {
    fallbackCalls += 1;
    return { progressed: true, crafted: true, traded: false };
  };

  const item = {
    code: 'ash_plank',
    craft: {
      skill: 'weaponcrafting',
      quantity: 1,
      items: [{ code: 'ash_wood', quantity: 5 }],
    },
  };
  const plan = [{
    type: 'gather',
    itemCode: 'ash_wood',
    quantity: 5,
    resource: { code: 'ash_tree', skill: 'woodcutting', level: 1 },
  }];
  const ctx = {
    name: 'Tester',
    inventoryCapacity: () => 120,
    inventoryCount: () => 110,
    inventoryFull: () => false,
    itemCount: () => 0,
  };

  const result = await routine._craftForItemTask(ctx, 'ash_plank', item, plan, 24);
  assert.equal(result, true, 'overflow fallback should keep item-task flow progressing');
  assert.equal(fallbackCalls, 1, 'craft/trade fallback should be attempted before gathering');
}

async function testItemTaskReserveOverflowYieldsWhenNoFallbackProgress() {
  const routine = new SkillRotationRoutine();
  let fallbackCalls = 0;

  routine._withdrawForItemTask = async () => 0;
  routine._craftAndTradeItemTaskFromInventory = async () => {
    fallbackCalls += 1;
    return { progressed: false, crafted: false, traded: false };
  };

  const item = {
    code: 'ash_plank',
    craft: {
      skill: 'weaponcrafting',
      quantity: 1,
      items: [{ code: 'ash_wood', quantity: 5 }],
    },
  };
  const plan = [{
    type: 'gather',
    itemCode: 'ash_wood',
    quantity: 5,
    resource: { code: 'ash_tree', skill: 'woodcutting', level: 1 },
  }];
  const ctx = {
    name: 'Tester',
    inventoryCapacity: () => 120,
    inventoryCount: () => 110,
    inventoryFull: () => false,
    itemCount: () => 0,
  };

  const result = await routine._craftForItemTask(ctx, 'ash_plank', item, plan, 24);
  assert.equal(result, false, 'overflow with no craft/trade progress should yield');
  assert.equal(fallbackCalls, 1, 'fallback should be attempted once before yielding');
}

async function testCraftingWithdrawSkipsFinalRecipeOutput() {
  const state = {
    bank: new Map([
      ['fire_bow', 7],
      ['fire_string', 4],
      ['ash_wood', 12],
    ]),
    withdrawCalls: [],
  };

  const fakeApi = {
    async getBankItems({ page }) {
      if (page > 1) return [];
      return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
    },
    async move() {
      return {};
    },
    async waitForCooldown() {},
    async withdrawBank(items) {
      for (const entry of items) {
        const code = entry?.code;
        const qty = Number(entry?.quantity) || 0;
        if (!code || qty <= 0) continue;
        const have = state.bank.get(code) || 0;
        if (have < qty) throw new Error(`not enough ${code}`);
        const next = have - qty;
        if (next > 0) state.bank.set(code, next);
        else state.bank.delete(code);
        state.withdrawCalls.push({ code, quantity: qty });
      }
      return {};
    },
  };

  resetInventoryForTests();
  resetBankOpsForTests();
  setInventoryApiForTests(fakeApi);
  setBankOpsApiForTests(fakeApi);

  try {
    await getBankItems(true);

    const routine = new SkillRotationRoutine();
    routine.rotation = {
      productionPlan: [
        { type: 'bank', itemCode: 'ash_wood', quantity: 2 },
        { type: 'craft', itemCode: 'fire_string', quantity: 1, recipe: { items: [] } },
        { type: 'craft', itemCode: 'fire_bow', quantity: 1, recipe: { items: [] } },
      ],
      recipe: { code: 'fire_bow' },
    };

    const ctx = {
      name: 'Tester',
      isAt: () => true,
      inventoryCapacity: () => 20,
      inventoryCount: () => 0,
      itemCount: () => 0,
      refresh: async () => {},
    };

    await routine._withdrawFromBank(ctx, routine.rotation.productionPlan, routine.rotation.recipe.code, 1);

    assert.equal(state.withdrawCalls.some(row => row.code === 'fire_bow'), false);
    assert.deepEqual(
      state.withdrawCalls.map(row => row.code),
      ['fire_string', 'ash_wood'],
    );
  } finally {
    resetInventoryForTests();
    resetBankOpsForTests();
  }
}

async function testCraftingWithdrawHonorsReserveMaxUnits() {
  const state = {
    bank: new Map([
      ['fire_bow', 7],
      ['fire_string', 4],
      ['ash_wood', 12],
    ]),
    withdrawCalls: [],
  };

  const fakeApi = {
    async getBankItems({ page }) {
      if (page > 1) return [];
      return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
    },
    async move() {
      return {};
    },
    async waitForCooldown() {},
    async withdrawBank(items) {
      for (const entry of items) {
        const code = entry?.code;
        const qty = Number(entry?.quantity) || 0;
        if (!code || qty <= 0) continue;
        const have = state.bank.get(code) || 0;
        if (have < qty) throw new Error(`not enough ${code}`);
        const next = have - qty;
        if (next > 0) state.bank.set(code, next);
        else state.bank.delete(code);
        state.withdrawCalls.push({ code, quantity: qty });
      }
      return {};
    },
  };

  resetInventoryForTests();
  resetBankOpsForTests();
  setInventoryApiForTests(fakeApi);
  setBankOpsApiForTests(fakeApi);

  try {
    await getBankItems(true);

    const routine = new SkillRotationRoutine();
    routine.rotation = {
      productionPlan: [
        { type: 'bank', itemCode: 'ash_wood', quantity: 2 },
        { type: 'craft', itemCode: 'fire_string', quantity: 1, recipe: { items: [] } },
        { type: 'craft', itemCode: 'fire_bow', quantity: 1, recipe: { items: [] } },
      ],
      recipe: { code: 'fire_bow' },
    };

    const ctx = {
      name: 'Tester',
      isAt: () => true,
      inventoryCapacity: () => 120,
      inventoryCount: () => 107,
      itemCount: () => 0,
      refresh: async () => {},
    };

    await routine._withdrawFromBank(ctx, routine.rotation.productionPlan, routine.rotation.recipe.code, 1);

    assert.equal(
      state.withdrawCalls.reduce((sum, row) => sum + row.quantity, 0),
      1,
      'reserve-aware maxUnits should cap total crafting withdrawal to one unit',
    );
    assert.deepEqual(
      state.withdrawCalls.map(row => row.code),
      ['fire_string'],
      'when capped, withdrawal should prioritize higher-value reversed plan step',
    );
  } finally {
    resetInventoryForTests();
    resetBankOpsForTests();
  }
}

function makeMutableCtx(state) {
  return {
    name: state.name || 'Tester',
    get() {
      return {
        x: state.x || 0,
        y: state.y || 0,
        inventory: [...state.inventory.entries()].map(([code, quantity]) => ({ code, quantity })),
      };
    },
    settings() {
      return {
        potions: {
          enabled: false,
          bankTravel: { enabled: false },
        },
      };
    },
    isAt(x, y) {
      return (state.x || 0) === x && (state.y || 0) === y;
    },
    itemCount(code) {
      return state.inventory.get(code) || 0;
    },
    inventoryCount() {
      let total = 0;
      for (const qty of state.inventory.values()) total += qty;
      return total;
    },
    inventoryCapacity() {
      return 20;
    },
    taskCoins() {
      return state.inventory.get('tasks_coin') || 0;
    },
    async refresh() {},
  };
}

async function testContextTaskCoinsUsesInventoryOnly() {
  const inventoryOnly = new CharacterContext('InventoryOnly');
  inventoryOnly._char = {
    inventory: [
      { code: 'tasks_coin', quantity: 5 },
      { code: 'apple', quantity: 3 },
    ],
  };
  assert.equal(inventoryOnly.taskCoins(), 5, 'taskCoins should count tasks_coin from inventory');

  const none = new CharacterContext('NoCoins');
  none._char = {
    inventory: [
      { code: 'apple', quantity: 3 },
    ],
  };
  assert.equal(none.taskCoins(), 0, 'taskCoins should return 0 when tasks_coin is absent');
}

async function testRoutineTriggersProactiveExchangeBeforeSkillDispatch() {
  const routine = new SkillRotationRoutine();
  let proactiveCalls = 0;
  let combatCalls = 0;

  routine._maybeRunProactiveExchange = async () => {
    proactiveCalls += 1;
    return { attempted: true, exchanged: 1, resolved: false, reason: 'insufficient_coins' };
  };
  routine._executeCombat = async () => {
    combatCalls += 1;
    return true;
  };
  routine.rotation = {
    currentSkill: 'combat',
    isGoalComplete: () => false,
  };

  const result = await routine.execute({
    name: 'Tester',
    inventoryFull: () => false,
  });

  assert.equal(result, true);
  assert.equal(proactiveCalls, 1, 'execute should call proactive exchange hook once');
  assert.equal(combatCalls, 0, 'skill dispatch should be skipped when proactive exchange does work');
}

async function testTaskExchangeLockPreventsConcurrentRuns() {
  const routineA = new SkillRotationRoutine();
  const routineB = new SkillRotationRoutine();
  const targets = new Map([['jasper_crystal', 1]]);

  let releaseGate;
  const gate = new Promise(resolve => {
    releaseGate = resolve;
  });

  routineA._getBankItems = async () => new Map();
  routineA._computeUnmetTargets = () => new Map([['jasper_crystal', 1]]);
  routineA._ensureExchangeCoinsInInventory = async () => {
    await gate;
    return { ok: false, available: 0 };
  };

  const runA = routineA._runTaskExchange(
    {
      name: 'LockA',
      itemCount: () => 0,
      inventoryCount: () => 0,
      inventoryCapacity: () => 20,
      taskCoins: () => 0,
    },
    { targets, trigger: 'lock-a', proactive: true },
  );

  await Promise.resolve();

  const resultB = await routineB._runTaskExchange(
    {
      name: 'LockB',
      itemCount: () => 0,
      inventoryCount: () => 0,
      inventoryCapacity: () => 20,
      taskCoins: () => 0,
    },
    { targets, trigger: 'lock-b', proactive: true },
  );

  assert.equal(resultB.reason, 'lock_busy', 'second routine should defer while lock holder is active');
  releaseGate();
  await runA;
}

async function testTaskExchangeWithdrawsCoinsAndDepositsTargetRewards() {
  const state = {
    x: 4,
    y: 1,
    bank: new Map([['tasks_coin', 12]]),
    inventory: new Map(),
    withdrawCalls: [],
    depositCalls: [],
  };

  const fakeApi = {
    async getMaps(params = {}) {
      if (params.content_type === 'bank') {
        return [{ x: 4, y: 1, name: 'bank', access: { conditions: [] } }];
      }
      return [];
    },
    async getBankItems({ page }) {
      if (page > 1) return [];
      return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
    },
    async move(x, y) {
      state.x = x;
      state.y = y;
      return {};
    },
    async waitForCooldown() {},
    async withdrawBank(items) {
      for (const row of items) {
        const code = `${row?.code || ''}`.trim();
        const qty = Math.max(0, Number(row?.quantity) || 0);
        if (!code || qty <= 0) continue;
        const have = state.bank.get(code) || 0;
        if (have < qty) throw new Error(`not enough ${code}`);
        const nextBank = have - qty;
        if (nextBank > 0) state.bank.set(code, nextBank);
        else state.bank.delete(code);
        state.inventory.set(code, (state.inventory.get(code) || 0) + qty);
        state.withdrawCalls.push({ code, quantity: qty });
      }
      return {};
    },
    async depositBank(items) {
      for (const row of items) {
        const code = `${row?.code || ''}`.trim();
        const qty = Math.max(0, Number(row?.quantity) || 0);
        if (!code || qty <= 0) continue;
        const have = state.inventory.get(code) || 0;
        if (have < qty) throw new Error(`not enough inventory ${code}`);
        const nextInv = have - qty;
        if (nextInv > 0) state.inventory.set(code, nextInv);
        else state.inventory.delete(code);
        state.bank.set(code, (state.bank.get(code) || 0) + qty);
        state.depositCalls.push({ code, quantity: qty });
      }
      return {};
    },
  };

  resetInventoryForTests();
  resetBankOpsForTests();
  setInventoryApiForTests(fakeApi);
  setBankOpsApiForTests(fakeApi);

  try {
    await getBankItems(true);

    const routine = new SkillRotationRoutine();
    routine._getBankItems = async () => new Map(state.bank);
    routine._performTaskExchange = async () => {
      const coins = state.inventory.get('tasks_coin') || 0;
      assert.ok(coins >= 6, 'exchange should run only after coins are withdrawn to inventory');
      const nextCoins = coins - 6;
      if (nextCoins > 0) state.inventory.set('tasks_coin', nextCoins);
      else state.inventory.delete('tasks_coin');
      state.inventory.set('jasper_crystal', (state.inventory.get('jasper_crystal') || 0) + 1);
    };

    const result = await routine._runTaskExchange(makeMutableCtx(state), {
      targets: new Map([['jasper_crystal', 1]]),
      trigger: 'test',
      proactive: true,
    });

    assert.equal(result.resolved, true, 'target reward should be satisfied after proactive exchange');
    assert.ok(
      state.withdrawCalls.some(row => row.code === 'tasks_coin'),
      'coins should be withdrawn from bank for exchange',
    );
    assert.ok(
      state.depositCalls.some(row => row.code === 'jasper_crystal'),
      'gained target rewards should be deposited to bank',
    );
    assert.equal(state.bank.get('jasper_crystal') || 0, 1);
  } finally {
    resetInventoryForTests();
    resetBankOpsForTests();
  }
}

async function run() {
  await testContextTaskCoinsUsesInventoryOnly();
  await testAlchemyFallbackToGatherAtLevel1();
  await testAlchemyCraftingSelectsViableRecipe();
  await testAlchemyCraftingNonViableFallsBackToGathering();
  await testCraftingXpPrefersBankOnlyRecipe();
  await testCraftingXpFallsBackToHighestLevelWhenNoBankOnly();
  await testCraftingSkipsTemporarilyBlockedRecipe();
  await testUnwinnableCombatRecipeIsTemporarilyBlocked();
  await testOrderBoardCreatesGatherOrderForUnmetGatherSkill();
  await testOrderBoardCanDisableOrderCreation();
  await testOrderBoardCreatesFightOrderForUnwinnableMonsterDrop();
  await testAcquireCraftClaimSkipsUnwinnableFightAndBlocksChar();
  await testAcquireCraftClaimSkipsMissingBankDependencyAndBlocksChar();
  await testAcquireCraftClaimRetriesTaskRewardDependencyWithProactiveExchange();
  await testAcquireCraftClaimSucceedsWhenPrechecksPass();
  await testAcquireGatherClaimPrioritizesToolOrders();
  await testAcquireCombatClaimPrioritizesToolOrders();
  await testAcquireCraftClaimPrioritizesToolOrders();
  await testCraftFightStepSkipsCombatWhenSimUnwinnable();
  await testHandleUnwinnableCraftFightBlocksRecipeAndRotates();
  await testHandleUnwinnableCraftFightBlocksAndReleasesClaim();
  await testCraftFightReadyFalseWithClaimBlocksAndReleasesClaim();
  await testCraftFightReadyFalseWithoutClaimBlocksRecipeAndRotates();
  await testRoutineCanDisableOrderFulfillment();
  await testRoutineRoutesCraftClaimsBySkill();
  await testRoutineCraftingFallsBackWhenNoCraftClaim();
  await testRoutineSkipsGoalProgressWhileOrderClaimIsActive();
  await testRoutineDispatchesAlchemyGatheringMode();
  await testRoutineDispatchesAlchemyCraftingMode();
  await testBatchSizeRespectsInventoryReserve();
  await testItemTaskTradeDecisionDefersBelowBatchWhenGatherable();
  await testItemTaskTradeDecisionTradesAtBatchTarget();
  await testItemTaskTradeDecisionTradesWhenInventoryFull();
  await testItemTaskTradeDecisionTradesWhenNotGatherable();
  await testItemTaskFlowDefersTradeUntilBatchWhenGatherable();
  await testItemTaskFlowTradesAtBatchThresholdWhenGatherable();
  await testItemTaskFlowTradesImmediatelyAfterBankWithdraw();
  await testItemTaskWithdrawRespectsReserveCap();
  await testItemTaskReserveOverflowUsesCraftTradeFallback();
  await testItemTaskReserveOverflowYieldsWhenNoFallbackProgress();
  await testRoutineTriggersProactiveExchangeBeforeSkillDispatch();
  await testTaskExchangeLockPreventsConcurrentRuns();
  await testTaskExchangeWithdrawsCoinsAndDepositsTargetRewards();
  await testCraftingWithdrawSkipsFinalRecipeOutput();
  await testCraftingWithdrawHonorsReserveMaxUnits();
  resetOrderPriorityForTests();
  console.log('skill-rotation tests passed');
}

run().catch((err) => {
  resetOrderPriorityForTests();
  console.error(err);
  process.exit(1);
});
