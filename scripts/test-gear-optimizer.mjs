#!/usr/bin/env node
import assert from 'node:assert/strict';

const gearOptimizer = await import('../src/services/gear-optimizer.mjs');

const {
  _chooseBestBagCandidateForTests,
  _resetDepsForTests,
  _setDepsForTests,
  findBestCombatTarget,
  optimizeForGathering,
  optimizeForMonster,
} = gearOptimizer;

function makeItem(code, { level = 1, effects = [], craft = null } = {}) {
  const item = { code, level, effects };
  if (craft) item.craft = craft;
  return item;
}

function candidate(item, source = 'inventory') {
  return { item, source };
}

function invSpace(value) {
  return [{ code: 'inventory_space', value }];
}

function makeCtx({
  level = 10,
  equipped = {},
  inventory = {},
} = {}) {
  const char = {
    level,
    weapon_slot: equipped.weapon || null,
    shield_slot: equipped.shield || null,
    helmet_slot: equipped.helmet || null,
    body_armor_slot: equipped.body_armor || null,
    leg_armor_slot: equipped.leg_armor || null,
    boots_slot: equipped.boots || null,
    ring1_slot: equipped.ring1 || null,
    ring2_slot: equipped.ring2 || null,
    amulet_slot: equipped.amulet || null,
    artifact1_slot: equipped.artifact1 || null,
    artifact2_slot: equipped.artifact2 || null,
    artifact3_slot: equipped.artifact3 || null,
    bag_slot: equipped.bag || null,
    rune_slot: equipped.rune || null,
  };

  const inv = new Map(Object.entries(inventory).map(([code, qty]) => [code, Number(qty) || 0]));

  return {
    name: 'Tester',
    get() {
      return char;
    },
    hasItem(code) {
      return (inv.get(code) || 0) > 0;
    },
    itemCount(code) {
      return inv.get(code) || 0;
    },
  };
}

function installOptimizerDeps({
  itemsByCode = new Map(),
  equipmentBySlot = new Map(),
  gatherTools = [],
  npcOffers = new Map(),
} = {}) {
  _setDepsForTests({
    getMonsterFn: () => ({ code: 'test_monster' }),
    getMonsterLocationFn: async () => ({ x: 0, y: 0 }),
    findMonstersByLevelFn: () => [],
    getBankItemsFn: async () => new Map(),
    getItemFn: (code) => itemsByCode.get(code) || null,
    getEquipmentForSlotFn: (slot) => equipmentBySlot.get(slot) || [],
    findItemsFn: ({ type, subtype } = {}) => {
      if (type === 'weapon' && subtype === 'tool') return gatherTools;
      return [];
    },
    findNpcForItemFn: (code) => npcOffers.get(code) || null,
    bankCountFn: () => 0,
    calcTurnDamageFn: () => 1,
    simulateCombatFn: () => ({
      win: true,
      remainingHp: 100,
      turns: 1,
      hpLostPercent: 0,
    }),
  });
}

function testBagRankingPrefersInventorySpace() {
  _resetDepsForTests();
  const best = _chooseBestBagCandidateForTests([
    candidate(makeItem('satchel', { level: 5, effects: invSpace(1) })),
    candidate(makeItem('backpack', { level: 10, effects: invSpace(2) })),
  ]);
  assert.equal(best?.item?.code, 'backpack');
}

function testBagRankingBreaksTieByLevel() {
  _resetDepsForTests();
  const best = _chooseBestBagCandidateForTests([
    candidate(makeItem('tier1_bag', { level: 5, effects: invSpace(2) })),
    candidate(makeItem('tier2_bag', { level: 20, effects: invSpace(2) })),
  ]);
  assert.equal(best?.item?.code, 'tier2_bag');
}

function testBagRankingBreaksFinalTieByCodeAsc() {
  _resetDepsForTests();
  const best = _chooseBestBagCandidateForTests([
    candidate(makeItem('zeta_bag', { level: 20, effects: invSpace(2) })),
    candidate(makeItem('alpha_bag', { level: 20, effects: invSpace(2) })),
  ]);
  assert.equal(best?.item?.code, 'alpha_bag');
}

async function testOptimizeForMonsterIncludesBestBag() {
  _resetDepsForTests();

  const satchel = makeItem('satchel', { level: 5, effects: invSpace(1) });
  const backpack = makeItem('backpack', { level: 10, effects: invSpace(2) });
  const itemsByCode = new Map([
    [satchel.code, satchel],
    [backpack.code, backpack],
  ]);
  const equipmentBySlot = new Map([
    ['bag', [satchel, backpack]],
  ]);

  installOptimizerDeps({ itemsByCode, equipmentBySlot });

  const ctx = makeCtx({
    level: 10,
    inventory: {
      satchel: 1,
      backpack: 1,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('bag'), 'backpack', 'combat optimizer should select highest-capacity bag');
}

async function testOptimizeForGatheringIncludesBestBag() {
  _resetDepsForTests();

  const satchel = makeItem('satchel', { level: 5, effects: invSpace(1) });
  const backpack = makeItem('backpack', { level: 10, effects: invSpace(2) });
  const pickaxe = makeItem('copper_pickaxe', {
    level: 1,
    effects: [{ code: 'mining', value: 1 }],
  });

  const itemsByCode = new Map([
    [satchel.code, satchel],
    [backpack.code, backpack],
    [pickaxe.code, pickaxe],
  ]);
  const equipmentBySlot = new Map([
    ['bag', [satchel, backpack]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
    gatherTools: [pickaxe],
  });

  const ctx = makeCtx({
    level: 10,
    inventory: {
      satchel: 1,
      backpack: 1,
      copper_pickaxe: 1,
    },
  });

  const result = await optimizeForGathering(ctx, 'mining');
  assert.ok(result, 'optimizeForGathering should return a result');
  assert.equal(result.loadout.get('weapon'), 'copper_pickaxe');
  assert.equal(result.loadout.get('bag'), 'backpack', 'gathering optimizer should select highest-capacity bag');
}

async function testOptimizeForMonsterUsesCandidateRuneEffects() {
  _resetDepsForTests();

  const burnRune = makeItem('burn_rune', { level: 20, effects: [{ code: 'burn', value: 20 }] });
  const healingRune = makeItem('healing_rune', { level: 20, effects: [{ code: 'healing', value: 5 }] });
  const itemsByCode = new Map([
    [burnRune.code, burnRune],
    [healingRune.code, healingRune],
  ]);
  const equipmentBySlot = new Map([
    ['rune', [burnRune, healingRune]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  _setDepsForTests({
    simulateCombatFn: (_stats, _monster, options = {}) => {
      const code = options?.rune?.code || null;
      return {
        win: true,
        remainingHp: code === 'burn_rune' ? 150 : 100,
        turns: code === 'burn_rune' ? 3 : 5,
        hpLostPercent: code === 'burn_rune' ? 10 : 30,
      };
    },
  });

  const ctx = makeCtx({
    level: 20,
    equipped: {
      rune: 'healing_rune',
    },
    inventory: {
      burn_rune: 1,
      healing_rune: 1,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('rune'), 'burn_rune', 'optimizer should evaluate the candidate rune, not the currently equipped one');
}

async function testOptimizeForMonsterUsesStableSeedPerSlotComparison() {
  _resetDepsForTests();

  const burnRune = makeItem('burn_rune', { level: 20, effects: [{ code: 'burn', value: 20 }] });
  const healingRune = makeItem('healing_rune', { level: 20, effects: [{ code: 'healing', value: 5 }] });
  const itemsByCode = new Map([
    [burnRune.code, burnRune],
    [healingRune.code, healingRune],
  ]);
  const equipmentBySlot = new Map([
    ['rune', [burnRune, healingRune]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  const calls = [];
  _setDepsForTests({
    simulateCombatFn: (_stats, _monster, options = {}) => {
      calls.push({
        iterations: options.iterations,
        seed: options.seed,
        rune: options?.rune?.code || null,
      });
      return {
        win: true,
        remainingHp: 100,
        turns: 5,
        hpLostPercent: 10,
      };
    },
    findRequiredHpForFightFn: () => ({ requiredHp: null }),
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      burn_rune: 1,
      healing_rune: 1,
    },
  });

  await optimizeForMonster(ctx, 'test_monster');

  const comparisonCalls = calls.filter(call => call.iterations === 200);
  const countsBySeed = new Map();
  for (const call of comparisonCalls) {
    countsBySeed.set(call.seed, (countsBySeed.get(call.seed) || 0) + 1);
  }
  assert.equal(
    Math.max(...countsBySeed.values()),
    3,
    'same-slot comparisons should share a seed across both rune candidates and the empty slot',
  );
}

async function testOptimizeForMonsterSupportsArtifactSlots() {
  _resetDepsForTests();

  const noviceGuide = makeItem('novice_guide', { level: 10, effects: [{ code: 'wisdom', value: 25 }] });
  const itemsByCode = new Map([[noviceGuide.code, noviceGuide]]);
  const equipmentBySlot = new Map([
    ['artifact1', [noviceGuide]],
    ['artifact2', [noviceGuide]],
    ['artifact3', [noviceGuide]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  _setDepsForTests({
    simulateCombatFn: (stats) => ({
      win: true,
      remainingHp: stats.wisdom || 0,
      turns: 10,
      hpLostPercent: 0,
    }),
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      novice_guide: 1,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('artifact1'), 'novice_guide', 'combat optimizer should select an owned artifact item');
  assert.equal(result.loadout.get('artifact2'), null, 'single-copy artifacts should not be duplicated into artifact2');
  assert.equal(result.loadout.get('artifact3'), null, 'single-copy artifacts should not be duplicated into artifact3');
}

async function testOptimizeForMonsterDoesNotDuplicateArtifactCopies() {
  _resetDepsForTests();

  const noviceGuide = makeItem('novice_guide', { level: 10, effects: [{ code: 'wisdom', value: 25 }] });
  const itemsByCode = new Map([[noviceGuide.code, noviceGuide]]);
  const equipmentBySlot = new Map([
    ['artifact1', [noviceGuide]],
    ['artifact2', [noviceGuide]],
    ['artifact3', [noviceGuide]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  _setDepsForTests({
    simulateCombatFn: (stats) => ({
      win: true,
      remainingHp: stats.wisdom || 0,
      turns: 10,
      hpLostPercent: 0,
    }),
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      novice_guide: 2,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('artifact1'), 'novice_guide', 'first artifact slot should use the owned artifact');
  assert.equal(result.loadout.get('artifact2'), null, 'artifact2 should stay empty even when a second copy exists');
  assert.equal(result.loadout.get('artifact3'), null, 'artifact3 should stay empty even when multiple copies exist');
}

async function testOptimizeForMonsterAllowsDuplicateRingsWhenEnoughCopiesExist() {
  _resetDepsForTests();

  const scholarRing = makeItem('scholar_ring', { level: 10, effects: [{ code: 'wisdom', value: 25 }] });
  const itemsByCode = new Map([[scholarRing.code, scholarRing]]);
  const equipmentBySlot = new Map([
    ['ring1', [scholarRing]],
    ['ring2', [scholarRing]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  _setDepsForTests({
    simulateCombatFn: (stats) => ({
      win: true,
      remainingHp: stats.wisdom || 0,
      turns: 10,
      hpLostPercent: 0,
    }),
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      scholar_ring: 2,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('ring1'), 'scholar_ring', 'first ring slot should use the owned ring');
  assert.equal(result.loadout.get('ring2'), 'scholar_ring', 'ring2 should still allow the same ring when enough copies exist');
}

async function testOptimizeForGatheringIncludesArtifactProspecting() {
  _resetDepsForTests();

  const noviceGuide = makeItem('novice_guide', { level: 10, effects: [{ code: 'prospecting', value: 25 }] });
  const pickaxe = makeItem('copper_pickaxe', {
    level: 1,
    effects: [{ code: 'mining', value: 1 }],
  });
  const itemsByCode = new Map([
    [noviceGuide.code, noviceGuide],
    [pickaxe.code, pickaxe],
  ]);
  const equipmentBySlot = new Map([
    ['artifact1', [noviceGuide]],
    ['artifact2', [noviceGuide]],
    ['artifact3', [noviceGuide]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
    gatherTools: [pickaxe],
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      novice_guide: 1,
      copper_pickaxe: 1,
    },
  });

  const result = await optimizeForGathering(ctx, 'mining');
  assert.ok(result, 'optimizeForGathering should return a result');
  assert.equal(result.loadout.get('artifact1'), 'novice_guide', 'gathering optimizer should select an artifact with prospecting');
  assert.equal(result.loadout.get('artifact2'), null, 'gathering optimizer should respect single-copy artifact limits');
  assert.equal(result.loadout.get('artifact3'), null, 'gathering optimizer should leave extra artifact slots empty without copies');
}

async function testOptimizeForGatheringDoesNotDuplicateArtifactCopies() {
  _resetDepsForTests();

  const noviceGuide = makeItem('novice_guide', { level: 10, effects: [{ code: 'prospecting', value: 25 }] });
  const pickaxe = makeItem('copper_pickaxe', {
    level: 1,
    effects: [{ code: 'mining', value: 1 }],
  });
  const itemsByCode = new Map([
    [noviceGuide.code, noviceGuide],
    [pickaxe.code, pickaxe],
  ]);
  const equipmentBySlot = new Map([
    ['artifact1', [noviceGuide]],
    ['artifact2', [noviceGuide]],
    ['artifact3', [noviceGuide]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
    gatherTools: [pickaxe],
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      novice_guide: 3,
      copper_pickaxe: 1,
    },
  });

  const result = await optimizeForGathering(ctx, 'mining');
  assert.ok(result, 'optimizeForGathering should return a result');
  assert.equal(result.loadout.get('artifact1'), 'novice_guide', 'gathering optimizer should still select the artifact');
  assert.equal(result.loadout.get('artifact2'), null, 'gathering optimizer should not duplicate the artifact into artifact2');
  assert.equal(result.loadout.get('artifact3'), null, 'gathering optimizer should not duplicate the artifact into artifact3');
}

async function testOptimizeForMonsterPlanningIncludesVendorRune() {
  _resetDepsForTests();

  const burnRune = makeItem('burn_rune', { level: 20, effects: [{ code: 'burn', value: 20 }] });
  const itemsByCode = new Map([[burnRune.code, burnRune]]);
  const equipmentBySlot = new Map([
    ['rune', [burnRune]],
  ]);
  const npcOffers = new Map([
    [burnRune.code, { npcCode: 'rune_vendor' }],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
    npcOffers,
  });

  const ctx = makeCtx({ level: 20 });
  const candidates = gearOptimizer.getCandidatesForSlot(ctx, 'rune', new Map(), {
    includeCraftableUnavailable: true,
  });

  assert.equal(candidates.length, 1, 'planning candidates should include a vendor rune');
  assert.equal(candidates[0].source, 'npc_buy');
}

async function testOptimizeForMonsterPrefersEmptyRuneOnTie() {
  _resetDepsForTests();

  const auraRune = makeItem('healing_aura_rune', { level: 20, effects: [{ code: 'healing_aura', value: 10 }] });
  const itemsByCode = new Map([[auraRune.code, auraRune]]);
  const equipmentBySlot = new Map([
    ['rune', [auraRune]],
  ]);

  installOptimizerDeps({
    itemsByCode,
    equipmentBySlot,
  });

  const ctx = makeCtx({
    level: 20,
    inventory: {
      healing_aura_rune: 1,
    },
  });

  const result = await optimizeForMonster(ctx, 'test_monster');
  assert.ok(result, 'optimizeForMonster should return a result');
  assert.equal(result.loadout.get('rune'), null, 'unsupported solo rune effects should not beat an empty rune slot on a tie');
}

async function testFindBestCombatTargetSkipsBosses() {
  _resetDepsForTests();

  installOptimizerDeps();
  _setDepsForTests({
    findMonstersByLevelFn: () => [
      { code: 'event_boss', level: 30, type: 'boss' },
      { code: 'regular_mob', level: 20, type: 'monster' },
    ],
    getMonsterLocationFn: async (code) => ({ x: code === 'event_boss' ? 9 : 1, y: 1 }),
    getMonsterFn: (code) => ({ code }),
    simulateCombatFn: (_stats, monster) => ({
      win: true,
      remainingHp: monster.code === 'event_boss' ? 500 : 100,
      turns: monster.code === 'event_boss' ? 1 : 3,
      hpLostPercent: monster.code === 'event_boss' ? 0 : 10,
    }),
  });

  const ctx = makeCtx({ level: 30 });
  const target = await findBestCombatTarget(ctx);
  assert.equal(target?.monsterCode, 'regular_mob', 'boss monsters should be excluded from local target selection');
}

async function run() {
  try {
    testBagRankingPrefersInventorySpace();
    testBagRankingBreaksTieByLevel();
    testBagRankingBreaksFinalTieByCodeAsc();
    await testOptimizeForMonsterIncludesBestBag();
    await testOptimizeForGatheringIncludesBestBag();
    await testOptimizeForMonsterUsesCandidateRuneEffects();
    await testOptimizeForMonsterUsesStableSeedPerSlotComparison();
    await testOptimizeForMonsterSupportsArtifactSlots();
    await testOptimizeForMonsterDoesNotDuplicateArtifactCopies();
    await testOptimizeForMonsterAllowsDuplicateRingsWhenEnoughCopiesExist();
    await testOptimizeForGatheringIncludesArtifactProspecting();
    await testOptimizeForGatheringDoesNotDuplicateArtifactCopies();
    await testOptimizeForMonsterPlanningIncludesVendorRune();
    await testOptimizeForMonsterPrefersEmptyRuneOnTie();
    await testFindBestCombatTargetSkipsBosses();
    console.log('test-gear-optimizer: PASS');
  } finally {
    _resetDepsForTests();
  }
}

run().catch((err) => {
  _resetDepsForTests();
  console.error(err);
  process.exit(1);
});
