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
