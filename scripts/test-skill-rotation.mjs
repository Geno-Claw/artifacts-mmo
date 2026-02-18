#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { SkillRotation } = await import('../src/services/skill-rotation.mjs');
const { SkillRotationRoutine } = await import('../src/routines/skill-rotation.mjs');

function makeCtx({ alchemyLevel = 1, itemCounts = {} } = {}) {
  return {
    name: 'Tester',
    skillLevel(skill) {
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

async function run() {
  await testAlchemyFallbackToGatherAtLevel1();
  await testAlchemyCraftingCollectionIsPreservedWhenViable();
  await testAlchemyCraftingNonViableFallsBackToGathering();
  await testRoutineDispatchesAlchemyGatheringMode();
  await testRoutineDispatchesAlchemyCraftingMode();
  console.log('skill-rotation tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
