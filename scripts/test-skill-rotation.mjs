#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { SkillRotation } = await import('../src/services/skill-rotation.mjs');
const { SkillRotationRoutine } = await import('../src/routines/skill-rotation.mjs');
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

    routine._getCraftClaimBankItems = async () => new Map();
    routine._getCraftClaimItem = () => ({
      code: 'cheese',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveCraftClaimPlan = () => [
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

    routine._getCraftClaimBankItems = async () => new Map();
    routine._getCraftClaimItem = () => ({
      code: 'rare_potion',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveCraftClaimPlan = () => [
      { type: 'bank', itemCode: 'event_core', quantity: 1 },
    ];
    routine._canFulfillCraftClaimPlan = () => true;
    let simCalls = 0;
    routine._simulateClaimFight = async () => {
      simCalls += 1;
      return { simResult: { win: true, hpLostPercent: 20 } };
    };

    const claim = await routine._acquireCraftOrderClaim(
      makeCtx({ skillLevels: { alchemy: 10 } }),
      'alchemy',
    );

    assert.equal(claim, null, 'claim should be skipped when bank dependency is missing');
    assert.equal(simCalls, 0, 'fight simulation should not run when bank step already fails');
    assert.equal(
      listClaimableOrders({ sourceType: 'craft', craftSkill: 'alchemy', charName: 'Tester' }).length,
      0,
      'skipped order should be blocked for this character',
    );
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

    routine._getCraftClaimBankItems = async () => new Map([['empty_vial', 1]]);
    routine._getCraftClaimItem = () => ({
      code: 'fang_elixir',
      craft: { skill: 'alchemy', level: 1, items: [] },
    });
    routine._resolveCraftClaimPlan = () => [
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
      routine._getCraftClaimBankItems = async () => new Map();
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

async function run() {
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
  await testAcquireCraftClaimSucceedsWhenPrechecksPass();
  await testAcquireGatherClaimPrioritizesToolOrders();
  await testAcquireCombatClaimPrioritizesToolOrders();
  await testAcquireCraftClaimPrioritizesToolOrders();
  await testCraftFightStepSkipsCombatWhenSimUnwinnable();
  await testHandleUnwinnableCraftFightBlocksRecipeAndRotates();
  await testHandleUnwinnableCraftFightBlocksAndReleasesClaim();
  await testRoutineCanDisableOrderFulfillment();
  await testRoutineRoutesCraftClaimsBySkill();
  await testRoutineCraftingFallsBackWhenNoCraftClaim();
  await testRoutineSkipsGoalProgressWhileOrderClaimIsActive();
  await testRoutineDispatchesAlchemyGatheringMode();
  await testRoutineDispatchesAlchemyCraftingMode();
  await testCraftingWithdrawSkipsFinalRecipeOutput();
  resetOrderPriorityForTests();
  console.log('skill-rotation tests passed');
}

run().catch((err) => {
  resetOrderPriorityForTests();
  console.error(err);
  process.exit(1);
});
