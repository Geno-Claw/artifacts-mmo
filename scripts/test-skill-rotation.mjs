#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { SkillRotation } = await import('../src/services/skill-rotation.mjs');
const { SkillRotationRoutine } = await import('../src/routines/skill-rotation.mjs');
const bankOps = await import('../src/services/bank-ops.mjs');
const inventoryManager = await import('../src/services/inventory-manager.mjs');

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

async function testAlchemyCraftingCollectionIsPreservedWhenViable() {
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
    { weights: { alchemy: 1 }, craftCollection: { alchemy: true } },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ alchemyLevel: 5 }));
  assert.equal(chosen, 'alchemy');
  assert.equal(rotation.isCollection, true);
  assert.equal(rotation.goalTarget, 1);
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
  assert.equal(rotation.isCollection, false);
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
  assert.equal(rotation.isCollection, false);
}

async function testCraftingCollectionPrefersBankOnlyMissingItem() {
  const lowBankRecipe = makeRecipe('seasoned_egg', 'cooking', 5);
  const highGatherRecipe = makeRecipe('royal_stew', 'cooking', 25);
  const planByRecipe = new Map([
    [lowBankRecipe.code, [
      { type: 'bank', itemCode: 'egg', quantity: 1 },
    ]],
    [highGatherRecipe.code, [
      {
        type: 'gather',
        itemCode: 'raw_venison',
        resource: { code: 'venison_hunt', skill: 'hunting', level: 1 },
        quantity: 2,
      },
    ]],
  ]);

  const stub = makeGameDataStub({
    findItems: ({ craftSkill, maxLevel }) =>
      craftSkill === 'cooking' && maxLevel >= 25 ? [highGatherRecipe, lowBankRecipe] : [],
    getBankItems: async () => new Map([['egg', 10]]),
    resolveRecipeChain: (craft) => planByRecipe.get(craft._testCode) || null,
    canFulfillPlan: () => true,
  });

  const rotation = new SkillRotation(
    {
      weights: { cooking: 1 },
      craftCollection: { cooking: true },
    },
    { gameDataSvc: stub, findBestCombatTargetFn: async () => null },
  );

  const chosen = await rotation.pickNext(makeCtx({ skillLevels: { cooking: 25 } }));
  assert.equal(chosen, 'cooking');
  assert.equal(rotation.recipe?.code, 'seasoned_egg');
  assert.equal(rotation.isCollection, true);
  assert.equal(rotation.goalTarget, 1);
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

    await routine._withdrawFromBank(ctx, 1);

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
  await testAlchemyCraftingCollectionIsPreservedWhenViable();
  await testAlchemyCraftingNonViableFallsBackToGathering();
  await testCraftingXpPrefersBankOnlyRecipe();
  await testCraftingXpFallsBackToHighestLevelWhenNoBankOnly();
  await testCraftingCollectionPrefersBankOnlyMissingItem();
  await testOrderBoardCreatesGatherOrderForUnmetGatherSkill();
  await testOrderBoardCanDisableOrderCreation();
  await testOrderBoardCreatesFightOrderForUnwinnableMonsterDrop();
  await testRoutineCanDisableOrderFulfillment();
  await testRoutineSkipsGoalProgressWhileOrderClaimIsActive();
  await testRoutineDispatchesAlchemyGatheringMode();
  await testRoutineDispatchesAlchemyCraftingMode();
  await testCraftingWithdrawSkipsFinalRecipeOutput();
  console.log('skill-rotation tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
