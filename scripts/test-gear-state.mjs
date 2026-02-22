#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gearState = await import('../src/services/gear-state.mjs');

const {
  _resetGearStateForTests,
  _setDepsForTests,
  flushGearState,
  getAssignedMap,
  getAvailableMap,
  getClaimedTotal,
  getCharacterGearState,
  getOwnedDeficitRequests,
  getOwnedKeepByCodeForInventory,
  initializeGearState,
  publishDesiredOrdersForCharacter,
  refreshGearState,
  registerContext,
} = gearState;

function mapLoadout(slots = {}) {
  return new Map(Object.entries(slots).filter(([, code]) => !!code));
}

function makeCtx({
  name,
  level = 1,
  capacity = 30,
  inventory = [],
  equipped = {},
  utility = {},
} = {}) {
  const char = {
    name,
    level,
    weapon_slot: equipped.weapon || 'none',
    shield_slot: equipped.shield || 'none',
    helmet_slot: equipped.helmet || 'none',
    body_armor_slot: equipped.body_armor || 'none',
    leg_armor_slot: equipped.leg_armor || 'none',
    boots_slot: equipped.boots || 'none',
    ring1_slot: equipped.ring1 || 'none',
    ring2_slot: equipped.ring2 || 'none',
    amulet_slot: equipped.amulet || 'none',
    bag_slot: equipped.bag || 'none',
    utility1_slot: utility.utility1 || '',
    utility1_slot_quantity: Number(utility.utility1Qty) || 0,
    utility2_slot: utility.utility2 || '',
    utility2_slot_quantity: Number(utility.utility2Qty) || 0,
    inventory: inventory
      .filter(row => row?.code && (Number(row.quantity) || 0) > 0)
      .map(row => ({ code: row.code, quantity: Number(row.quantity) })),
  };

  return {
    name,
    get() {
      return char;
    },
    setLevel(nextLevel) {
      char.level = Number(nextLevel) || 0;
    },
    inventoryCapacity() {
      return capacity;
    },
    itemCount(code) {
      const row = char.inventory.find(slot => slot.code === code);
      return row ? row.quantity : 0;
    },
  };
}

function sumObjectValues(obj = {}) {
  return Object.values(obj).reduce((sum, qty) => sum + (Number(qty) || 0), 0);
}

function assertOwnedMirrorsAvailable(state, label = 'state') {
  const owned = state?.owned || {};
  const available = state?.available || {};
  assert.deepEqual(
    available,
    owned,
    `${label}: compatibility field owned should mirror available`,
  );
}

function createBaseGameData(monsters = []) {
  return {
    findMonstersByLevel(maxLevel) {
      return monsters.filter(m => m.level <= maxLevel);
    },
    getItem() {
      return null;
    },
    getResourceForDrop() {
      return null;
    },
    getMonsterForDrop() {
      return null;
    },
  };
}

async function testRequiredMultiplicityDesiredAndPotionCarryAccounting(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Alpha',
    level: 20,
    capacity: 30,
    equipped: {
      weapon: 'iron_sword',
      ring1: 'ruby_ring',
    },
    utility: {
      utility1: 'minor_health_potion',
      utility1Qty: 2,
    },
    inventory: [
      { code: 'iron_shield', quantity: 1 },
      { code: 'minor_health_potion', quantity: 2 },
    ],
  });

  let bankRevision = 10;
  const counts = new Map([
    ['iron_sword', 1],
    ['iron_shield', 1],
    ['ruby_ring', 1],
    ['minor_health_potion', 4],
  ]);

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'ogre', level: 20 }]),
    optimizeForMonsterFn: async (_ctx, monsterCode) => {
      if (monsterCode !== 'ogre') return null;
      return {
        loadout: mapLoadout({
          weapon: 'iron_sword',
          shield: 'iron_shield',
          ring1: 'ruby_ring',
          ring2: 'ruby_ring',
        }),
        simResult: {
          win: true,
          hpLostPercent: 25,
          turns: 8,
          remainingHp: 110,
        },
      };
    },
    getBankRevisionFn: () => bankRevision,
    globalCountFn: (code) => counts.get(code) || 0,
    // Use legacy equipped-slot path for potions (this test doesn't mock the potion simulation).
    computeDesiredPotionsFn: null,
  });

  await initializeGearState({
    path: join(basePath, 'gear-multiplicity.json'),
    characters: [{
      name: 'Alpha',
      settings: {
        potions: {
          enabled: true,
          combat: { enabled: true, targetQuantity: 4 },
        },
      },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('Alpha');
  assert.ok(state, 'character state should exist');
  assertOwnedMirrorsAvailable(state, 'Alpha');
  assert.equal(state.required.ruby_ring, 2, 'ring slot multiplicity should be preserved');
  assert.equal(state.available.minor_health_potion, 4, 'available should include target potion quantity');
  assert.equal(state.assigned.minor_health_potion, 4, 'assigned should include target potion quantity');
  assert.equal(state.desired.ruby_ring, 1, 'desired should include ring deficit');
  assert.equal(state.desired.minor_health_potion, undefined, 'no potion deficit expected');

  const keepByCode = getOwnedKeepByCodeForInventory(ctx);
  assert.equal(
    keepByCode.minor_health_potion,
    2,
    'keep map should subtract equipped utility quantity from owned potion target',
  );

  const deficits = getOwnedDeficitRequests(ctx);
  assert.equal(deficits.length, 0, 'owned deficit list should exclude desired-but-unassigned shortages');

  bankRevision += 1;
  await refreshGearState();
  await flushGearState();
}

async function testBagIncludedInOwnedDeficitRequests(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Bagger',
    level: 10,
    capacity: 30,
  });

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'slime', level: 1 }]),
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'starter_sword',
        bag: 'adventurer_bag',
      }),
      simResult: {
        win: true,
        hpLostPercent: 5,
        turns: 2,
        remainingHp: 99,
      },
    }),
    getBankRevisionFn: () => 4,
    globalCountFn: (code) => {
      if (code === 'starter_sword') return 1;
      if (code === 'adventurer_bag') return 1;
      return 0;
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-bag-deficit.json'),
    characters: [{
      name: 'Bagger',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('Bagger');
  assert.ok(state, 'character state should exist');
  assertOwnedMirrorsAvailable(state, 'Bagger');
  assert.equal(state.required.adventurer_bag, 1, 'required should include bag slot item');
  assert.equal(state.available.adventurer_bag, 1, 'available should claim bag slot item');

  const deficits = getOwnedDeficitRequests(ctx);
  assert.deepEqual(
    deficits.find(row => row.code === 'adventurer_bag'),
    { code: 'adventurer_bag', quantity: 1 },
    'deficits should request owned bag item when not carried',
  );

  await flushGearState();
}

async function testTrimToFitReservesTenSlots(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Trimmer',
    level: 20,
    capacity: 13, // carry budget = 3
  });

  const counts = new Map([
    ['weapon_1', 2],
    ['shield_1', 2],
    ['helmet_1', 2],
    ['body_1', 2],
    ['legs_1', 2],
  ]);

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'dragon', level: 20 }]),
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'weapon_1',
        shield: 'shield_1',
        helmet: 'helmet_1',
        body_armor: 'body_1',
        leg_armor: 'legs_1',
      }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 6,
        remainingHp: 140,
      },
    }),
    getBankRevisionFn: () => 1,
    globalCountFn: (code) => counts.get(code) || 0,
  });

  await initializeGearState({
    path: join(basePath, 'gear-trim.json'),
    characters: [{
      name: 'Trimmer',
      settings: { potions: { enabled: false } },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('Trimmer');
  assert.ok(state, 'character state should exist');
  assertOwnedMirrorsAvailable(state, 'Trimmer');
  assert.equal(sumObjectValues(state.available), 3, 'available carry set should be trimmed to capacity-10 budget');
  assert.deepEqual(
    Object.keys(state.available).sort(),
    ['helmet_1', 'shield_1', 'weapon_1'],
    'trim should keep highest slot-priority items from best target first',
  );
  assert.equal(state.required.body_1, 1, 'required keeps pre-trim requirements');
  assert.equal(state.required.legs_1, 1, 'required keeps pre-trim requirements');

  await flushGearState();
}

async function testScarcityAssignmentUsesCharacterOrder(basePath) {
  _resetGearStateForTests();

  const alpha = makeCtx({ name: 'Alpha', level: 10, capacity: 30 });
  const beta = makeCtx({ name: 'Beta', level: 10, capacity: 30 });

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'wolf', level: 10 }]),
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'rare_blade' }),
      simResult: {
        win: true,
        hpLostPercent: 10,
        turns: 3,
        remainingHp: 95,
      },
    }),
    getBankRevisionFn: () => 3,
    globalCountFn: (code) => (code === 'rare_blade' ? 1 : 0),
  });

  await initializeGearState({
    path: join(basePath, 'gear-scarcity.json'),
    characters: [
      { name: 'Alpha', settings: {}, routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }] },
      { name: 'Beta', settings: {}, routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }] },
    ],
  });
  registerContext(alpha);
  registerContext(beta);
  await refreshGearState({ force: true });

  const alphaState = getCharacterGearState('Alpha');
  const betaState = getCharacterGearState('Beta');

  assertOwnedMirrorsAvailable(alphaState, 'Alpha scarcity');
  assertOwnedMirrorsAvailable(betaState, 'Beta scarcity');
  assert.equal(alphaState.available.rare_blade, 1, 'first character in config order should get scarce item');
  assert.equal(alphaState.desired.rare_blade, undefined);
  assert.equal(betaState.available.rare_blade, undefined);
  assert.equal(betaState.desired.rare_blade, 1, 'later character should receive desired deficit');

  await flushGearState();
}

async function testCraftableDisplacementKeepsFallbackAvailable(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Fallback',
    level: 18,
    capacity: 30,
    equipped: {
      weapon: 'sticky_sword',
    },
  });

  let bankRevision = 20;
  const counts = new Map([
    ['sticky_sword', 1],
    ['mushstaff', 0],
  ]);
  const itemsByCode = new Map([
    ['sticky_sword', { code: 'sticky_sword', type: 'weapon', level: 8 }],
    ['mushstaff', { code: 'mushstaff', type: 'weapon', level: 20, craft: { skill: 'weaponcrafting', level: 20 } }],
  ]);

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'cow', level: 8 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'mushstaff',
      }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 4,
        remainingHp: 120,
      },
    }),
    getBankRevisionFn: () => bankRevision,
    globalCountFn: (code) => counts.get(code) || 0,
  });

  await initializeGearState({
    path: join(basePath, 'gear-fallback-displacement.json'),
    characters: [{
      name: 'Fallback',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('Fallback');
  assert.ok(state, 'character state should exist');
  assertOwnedMirrorsAvailable(state, 'Fallback');
  assert.equal(state.desired.mushstaff, 1, 'desired should include missing craftable upgrade');
  assert.equal(state.available.sticky_sword, 1, 'fallback weapon should remain claimed while upgrade is missing');
  assert.equal(getAvailableMap('Fallback').get('sticky_sword') || 0, 1, 'available map getter should include fallback claim');
  assert.equal(getClaimedTotal('sticky_sword'), 1, 'claimed totals should protect fallback gear from recycler');

  bankRevision += 1;
  await refreshGearState();
  await flushGearState();
}

async function testTransitionCompletionDropsFallbackClaim(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Transitioner',
    level: 18,
    capacity: 30,
    equipped: {
      weapon: 'sticky_sword',
    },
  });

  let bankRevision = 30;
  const counts = new Map([
    ['sticky_sword', 1],
    ['mushstaff', 0],
  ]);
  const itemsByCode = new Map([
    ['sticky_sword', { code: 'sticky_sword', type: 'weapon', level: 8 }],
    ['mushstaff', { code: 'mushstaff', type: 'weapon', level: 20, craft: { skill: 'weaponcrafting', level: 20 } }],
  ]);

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'cow', level: 8 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'mushstaff',
      }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 4,
        remainingHp: 120,
      },
    }),
    getBankRevisionFn: () => bankRevision,
    globalCountFn: (code) => counts.get(code) || 0,
  });

  await initializeGearState({
    path: join(basePath, 'gear-fallback-transition.json'),
    characters: [{
      name: 'Transitioner',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  let state = getCharacterGearState('Transitioner');
  assert.equal(state.available.sticky_sword, 1, 'initial fallback claim should keep current weapon');
  assert.equal(state.desired.mushstaff, 1, 'desired should initially request missing upgrade');

  counts.set('mushstaff', 1);
  bankRevision += 1;
  await refreshGearState();

  state = getCharacterGearState('Transitioner');
  assert.equal(state.desired.mushstaff, undefined, 'desired should clear once upgrade is available');
  assert.equal(state.assigned.mushstaff, 1, 'assigned should capture the new upgrade');
  assert.equal(getAssignedMap('Transitioner').get('mushstaff') || 0, 1, 'assigned getter should expose upgrade assignment');
  assert.equal(state.available.sticky_sword, undefined, 'fallback claim should drop after transition completes');
  assert.equal(state.available.mushstaff, 1, 'available should mirror assigned once no fallback is needed');

  await flushGearState();
}

async function testKeepMapProtectsInventoryFallbackWhenUpgradeMissing(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'KeepFallback',
    level: 18,
    capacity: 30,
    equipped: {
      weapon: 'copper_pick',
    },
    inventory: [
      { code: 'sticky_sword', quantity: 1 },
    ],
  });

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'cow', level: 8 }]),
      getItem(code) {
        if (code === 'copper_pick') return { code, type: 'weapon', subtype: 'tool', level: 5 };
        if (code === 'sticky_sword') return { code, type: 'weapon', level: 8 };
        if (code === 'mushstaff') return { code, type: 'weapon', level: 20, craft: { skill: 'weaponcrafting', level: 20 } };
        return null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'mushstaff',
      }),
      simResult: {
        win: true,
        hpLostPercent: 35,
        turns: 5,
        remainingHp: 70,
      },
    }),
    getBankRevisionFn: () => 4,
    globalCountFn: (code) => {
      if (code === 'copper_pick') return 1;
      if (code === 'sticky_sword') return 1;
      return 0;
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-fallback-keep-map.json'),
    characters: [{
      name: 'KeepFallback',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('KeepFallback');
  assert.equal(state.desired.mushstaff, 1, 'missing upgrade should stay in desired');
  assert.equal(state.available.sticky_sword, 1, 'available should claim non-tool fallback from inventory');
  assert.equal(state.available.copper_pick, undefined, 'tool should not be preferred over non-tool fallback');

  const keepByCode = getOwnedKeepByCodeForInventory(ctx);
  assert.equal(keepByCode.sticky_sword, 1, 'inventory fallback weapon should be protected by keep map');

  await flushGearState();
}

async function testMigrationBackfillsAvailableFromLegacyOwned(basePath) {
  _resetGearStateForTests();

  const statePath = join(basePath, 'gear-state-migration-v1.json');
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    updatedAtMs: 123,
    bankRevisionSnapshot: 7,
    levels: { Legacy: 12 },
    characters: {
      Legacy: {
        owned: { sticky_sword: 1 },
        desired: { mushstaff: 1 },
        required: { mushstaff: 1 },
        selectedMonsters: ['cow'],
        bestTarget: 'cow',
        levelSnapshot: 12,
        bankRevisionSnapshot: 7,
        updatedAtMs: 123,
      },
    },
  }, null, 2)}\n`, 'utf-8');

  _setDepsForTests({
    gameDataSvc: createBaseGameData([]),
    optimizeForMonsterFn: async () => null,
    getBankRevisionFn: () => 7,
    globalCountFn: () => 0,
  });

  await initializeGearState({
    path: statePath,
    characters: [{
      name: 'Legacy',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });

  const state = getCharacterGearState('Legacy');
  assert.ok(state, 'migrated state should exist');
  assert.equal(state.available.sticky_sword, 1, 'available should be backfilled from legacy owned');
  assert.equal(state.owned.sticky_sword, 1, 'owned compatibility field should remain populated');
  assert.equal(state.assigned.sticky_sword, undefined, 'assigned should default empty for v1 migration');
  assert.equal(getAvailableMap('Legacy').get('sticky_sword') || 0, 1, 'available getter should read migrated claims');
  assert.equal(getAssignedMap('Legacy').size, 0, 'assigned getter should default to empty map');

  await flushGearState();
}

async function testRecomputeTriggersOnRevisionAndLevel(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'Trigger', level: 10, capacity: 30 });
  let bankRevision = 1;
  let optimizeCalls = 0;

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'slime', level: 1 }]),
    optimizeForMonsterFn: async () => {
      optimizeCalls += 1;
      return {
        loadout: mapLoadout({ weapon: 'starter_sword' }),
        simResult: {
          win: true,
          hpLostPercent: 5,
          turns: 2,
          remainingHp: 99,
        },
      };
    },
    getBankRevisionFn: () => bankRevision,
    globalCountFn: () => 10,
  });

  await initializeGearState({
    path: join(basePath, 'gear-triggers.json'),
    characters: [{
      name: 'Trigger',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);

  await refreshGearState({ force: true });
  assert.equal(optimizeCalls, 1, 'first compute should run once');

  await refreshGearState();
  assert.equal(optimizeCalls, 1, 'no-op refresh should not recompute without triggers');

  bankRevision += 1;
  await refreshGearState();
  assert.equal(optimizeCalls, 2, 'bank revision change should trigger recompute');

  ctx.setLevel(11);
  await refreshGearState();
  assert.equal(optimizeCalls, 3, 'level change should trigger recompute');

  await flushGearState();
}

async function testToolRequirementsIncludedWithCombatRequirements(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'Toolsmith',
    level: 20,
    capacity: 30,
    equipped: {
      weapon: 'combat_blade',
    },
  });

  const itemsByCode = new Map([
    ['combat_blade', { code: 'combat_blade', type: 'weapon', level: 10 }],
    ['mining_tool', { code: 'mining_tool', type: 'weapon', subtype: 'tool', level: 5 }],
    ['woodcutting_tool', { code: 'woodcutting_tool', type: 'weapon', subtype: 'tool', level: 5 }],
    ['fishing_tool', { code: 'fishing_tool', type: 'weapon', subtype: 'tool', level: 5 }],
    ['alchemy_tool', { code: 'alchemy_tool', type: 'weapon', subtype: 'tool', level: 5 }],
  ]);
  const counts = new Map([
    ['combat_blade', 1],
    ['mining_tool', 1],
    ['woodcutting_tool', 1],
    ['fishing_tool', 1],
    ['alchemy_tool', 1],
  ]);
  const toolBySkill = {
    mining: 'mining_tool',
    woodcutting: 'woodcutting_tool',
    fishing: 'fishing_tool',
    alchemy: 'alchemy_tool',
  };

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'wolf', level: 10 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'combat_blade',
      }),
      simResult: {
        win: true,
        hpLostPercent: 10,
        turns: 4,
        remainingHp: 90,
      },
    }),
    getBestToolForSkillAtLevelFn: (skill) => {
      const code = toolBySkill[skill];
      return code ? itemsByCode.get(code) : null;
    },
    getBankRevisionFn: () => 1,
    globalCountFn: (code) => counts.get(code) || 0,
  });

  await initializeGearState({
    path: join(basePath, 'gear-tool-requirements.json'),
    characters: [{
      name: 'Toolsmith',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('Toolsmith');
  assert.ok(state, 'character state should exist');
  assert.equal(state.required.combat_blade, 1, 'required should include combat weapon');
  assert.equal(state.required.mining_tool, 1, 'required should include mining tool');
  assert.equal(state.required.woodcutting_tool, 1, 'required should include woodcutting tool');
  assert.equal(state.required.fishing_tool, 1, 'required should include fishing tool');
  assert.equal(state.required.alchemy_tool, 1, 'required should include alchemy tool');
  assert.equal(state.assigned.mining_tool, 1, 'assigned should include tool claims when owned');
  assert.equal(state.available.mining_tool, 1, 'available should include tool claims when owned');
  assertOwnedMirrorsAvailable(state, 'Toolsmith');

  await flushGearState();
}

async function testToolDeficitNotSatisfiedByWeaponFallback(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'ToolGap',
    level: 20,
    capacity: 30,
    equipped: {
      weapon: 'sticky_sword',
    },
  });

  const itemsByCode = new Map([
    ['sticky_sword', { code: 'sticky_sword', type: 'weapon', level: 8 }],
    ['mushstaff', { code: 'mushstaff', type: 'weapon', level: 20, craft: { skill: 'weaponcrafting', level: 20 } }],
    ['copper_pick', { code: 'copper_pick', type: 'weapon', subtype: 'tool', level: 5, craft: { skill: 'weaponcrafting', level: 5 } }],
  ]);
  const counts = new Map([
    ['sticky_sword', 1],
    ['mushstaff', 0],
    ['copper_pick', 0],
  ]);

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'cow', level: 8 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'mushstaff',
      }),
      simResult: {
        win: true,
        hpLostPercent: 25,
        turns: 4,
        remainingHp: 100,
      },
    }),
    getBestToolForSkillAtLevelFn: (skill) => (skill === 'mining' ? itemsByCode.get('copper_pick') : null),
    getBankRevisionFn: () => 2,
    globalCountFn: (code) => counts.get(code) || 0,
  });

  await initializeGearState({
    path: join(basePath, 'gear-tool-fallback-separation.json'),
    characters: [{
      name: 'ToolGap',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('ToolGap');
  assert.ok(state, 'character state should exist');
  assert.equal(state.required.copper_pick, 1, 'required should include missing tool');
  assert.equal(state.desired.copper_pick, 1, 'tool deficit should remain desired');
  assert.equal(state.available.copper_pick, undefined, 'tool deficit should not be covered by non-tool fallback');
  assert.equal(state.available.sticky_sword, 1, 'non-tool fallback should still cover weapon deficit only');

  await flushGearState();
}

async function testGearStatePassesPlanningFlagToOptimizer(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'Planner', level: 10, capacity: 30 });
  const seenOpts = [];

  _setDepsForTests({
    gameDataSvc: createBaseGameData([{ code: 'slime', level: 1 }]),
    optimizeForMonsterFn: async (_ctx, _monsterCode, opts) => {
      seenOpts.push(opts || {});
      return {
        loadout: mapLoadout({ weapon: 'starter_sword' }),
        simResult: {
          win: true,
          hpLostPercent: 5,
          turns: 2,
          remainingHp: 99,
        },
      };
    },
    getBankRevisionFn: () => 12,
    globalCountFn: () => 10,
  });

  await initializeGearState({
    path: join(basePath, 'gear-planning-flag.json'),
    characters: [{
      name: 'Planner',
      settings: {},
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  assert.equal(seenOpts.length, 1, 'optimizer should be called for bracket monsters');
  assert.equal(
    seenOpts[0]?.includeCraftableUnavailable,
    true,
    'gear-state should request planning candidates including craftable unavailable gear',
  );

  await flushGearState();
}

async function testPublishDesiredOrdersCraftOnlyForGloballyMissing(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'CrafterOne', level: 20, capacity: 30 });
  const created = [];

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'target', level: 20 }]),
      getItem(code) {
        if (code === 'craft_missing' || code === 'craft_in_bank') {
          return {
            code,
            level: 12,
            craft: {
              skill: 'gearcrafting',
              level: 12,
            },
          };
        }
        return { code, level: 5 };
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'craft_missing',
        shield: 'craft_in_bank',
        helmet: 'noncraft_missing',
      }),
      simResult: {
        win: true,
        hpLostPercent: 40,
        turns: 7,
        remainingHp: 60,
      },
    }),
    getBankRevisionFn: () => 5,
    globalCountFn: (code) => {
      if (code === 'craft_missing') return 0;
      if (code === 'craft_in_bank') return 2; // exists already; should not create order
      if (code === 'noncraft_missing') return 0;
      return 0;
    },
    createOrMergeOrderFn: (request) => {
      created.push(request);
      return {
        id: `${request.sourceType}:${request.itemCode}`,
      };
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-orders.json'),
    characters: [{
      name: 'CrafterOne',
      settings: {},
      routines: [{
        type: 'skillRotation',
        orderBoard: {
          enabled: true,
          createOrders: true,
        },
      }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const added = publishDesiredOrdersForCharacter('CrafterOne');
  assert.equal(added, 1, 'only globally-missing craftable item should create an order');

  const byItem = new Map(created.map(order => [order.itemCode, order]));
  assert.equal(byItem.get('craft_missing')?.sourceType, 'craft');
  assert.equal(byItem.get('craft_missing')?.sourceCode, 'craft_missing');
  assert.equal(byItem.get('craft_missing')?.craftSkill, 'gearcrafting');
  assert.equal(byItem.get('craft_missing')?.recipeCode, 'gear_state:CrafterOne:craft_missing');
  assert.equal(byItem.has('craft_in_bank'), false, 'existing account stock should not create craft order');
  assert.equal(byItem.has('noncraft_missing'), false, 'non-craftable deficits should not create craft order');

  await flushGearState();
}

async function testPublishDesiredOrdersSkipsToolItems(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'ToolOrders', level: 20, capacity: 30 });
  const created = [];
  const itemsByCode = new Map([
    ['craft_weapon', {
      code: 'craft_weapon',
      type: 'weapon',
      level: 15,
      craft: { skill: 'weaponcrafting', level: 15 },
    }],
    ['needed_tool', {
      code: 'needed_tool',
      type: 'weapon',
      subtype: 'tool',
      level: 10,
      craft: { skill: 'weaponcrafting', level: 10 },
    }],
  ]);

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'target', level: 20 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'craft_weapon',
      }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 4,
        remainingHp: 90,
      },
    }),
    getBestToolForSkillAtLevelFn: (skill) => (skill === 'mining' ? itemsByCode.get('needed_tool') : null),
    getBankRevisionFn: () => 6,
    globalCountFn: () => 0,
    createOrMergeOrderFn: (request) => {
      created.push(request);
      return { id: `order-${request.itemCode}` };
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-orders-skip-tools.json'),
    characters: [{
      name: 'ToolOrders',
      settings: {},
      routines: [{
        type: 'skillRotation',
        orderBoard: {
          enabled: true,
          createOrders: true,
        },
      }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('ToolOrders');
  assert.equal(state.desired.craft_weapon, 1, 'craft weapon should remain desired when missing');
  assert.equal(state.desired.needed_tool, 1, 'tool should remain desired when missing');

  const added = publishDesiredOrdersForCharacter('ToolOrders');
  assert.equal(added, 1, 'only non-tool desired craft item should publish an order');
  assert.equal(created.length, 1, 'tool desired orders should be skipped');
  assert.equal(created[0].itemCode, 'craft_weapon');

  await flushGearState();
}

async function testDesiredCraftOrdersWhenAnotherCharacterOwnsCopy(basePath) {
  _resetGearStateForTests();

  const alpha = makeCtx({ name: 'Alpha', level: 20, capacity: 30 });
  const beta = makeCtx({ name: 'Beta', level: 20, capacity: 30 });
  const created = [];

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'target', level: 20 }]),
      getItem(code) {
        if (code === 'shared_craft_item') {
          return {
            code,
            level: 15,
            craft: {
              skill: 'gearcrafting',
              level: 15,
            },
          };
        }
        return { code, level: 1 };
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'shared_craft_item',
      }),
      simResult: {
        win: true,
        hpLostPercent: 30,
        turns: 5,
        remainingHp: 70,
      },
    }),
    getBankRevisionFn: () => 9,
    // Exactly one copy exists account-wide, but both characters need one.
    globalCountFn: (code) => (code === 'shared_craft_item' ? 1 : 0),
    createOrMergeOrderFn: (request) => {
      created.push(request);
      return { id: `${request.requesterName}:${request.itemCode}` };
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-orders-shared-copy.json'),
    characters: [
      {
        name: 'Alpha',
        settings: {},
        routines: [{ type: 'skillRotation', orderBoard: { enabled: true, createOrders: true } }],
      },
      {
        name: 'Beta',
        settings: {},
        routines: [{ type: 'skillRotation', orderBoard: { enabled: true, createOrders: true } }],
      },
    ],
  });

  registerContext(alpha);
  registerContext(beta);
  await refreshGearState({ force: true });

  const alphaCreated = publishDesiredOrdersForCharacter('Alpha');
  const betaCreated = publishDesiredOrdersForCharacter('Beta');
  assert.equal(alphaCreated, 0, 'first character should be assigned the scarce copy');
  assert.equal(
    betaCreated,
    1,
    'second character should still create craft order even though account already has one copy',
  );

  assert.equal(created.length, 1);
  assert.equal(created[0].requesterName, 'Beta');
  assert.equal(created[0].itemCode, 'shared_craft_item');
  assert.equal(created[0].sourceType, 'craft');
  assert.equal(created[0].craftSkill, 'gearcrafting');

  await flushGearState();
}

async function testFallbackOverClaimPreventedAcrossCharacters(basePath) {
  _resetGearStateForTests();

  // Both characters have sticky_sword equipped (globalCount=1).
  // Optimizer wants mushstaff (globalCount=0) for both.
  // Only one character should get sticky_sword as fallback, not both.
  const alpha = makeCtx({
    name: 'Alpha',
    level: 18,
    capacity: 30,
    equipped: { weapon: 'sticky_sword' },
  });
  const beta = makeCtx({
    name: 'Beta',
    level: 18,
    capacity: 30,
    equipped: { weapon: 'sticky_sword' },
  });

  const itemsByCode = new Map([
    ['sticky_sword', { code: 'sticky_sword', type: 'weapon', level: 8 }],
    ['mushstaff', { code: 'mushstaff', type: 'weapon', level: 20, craft: { skill: 'weaponcrafting', level: 20 } }],
  ]);

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'cow', level: 8 }]),
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'mushstaff' }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 4,
        remainingHp: 120,
      },
    }),
    getBankRevisionFn: () => 50,
    globalCountFn: (code) => (code === 'sticky_sword' ? 1 : 0),
  });

  await initializeGearState({
    path: join(basePath, 'gear-fallback-overclaim.json'),
    characters: [
      { name: 'Alpha', settings: {}, routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }] },
      { name: 'Beta', settings: {}, routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }] },
    ],
  });
  registerContext(alpha);
  registerContext(beta);
  await refreshGearState({ force: true });

  const alphaState = getCharacterGearState('Alpha');
  const betaState = getCharacterGearState('Beta');

  assertOwnedMirrorsAvailable(alphaState, 'Alpha fallback');
  assertOwnedMirrorsAvailable(betaState, 'Beta fallback');

  // Both should want mushstaff
  assert.equal(alphaState.desired.mushstaff, 1, 'Alpha should desire mushstaff');
  assert.equal(betaState.desired.mushstaff, 1, 'Beta should desire mushstaff');

  // Only first character should get sticky_sword fallback
  assert.equal(alphaState.available.sticky_sword, 1, 'Alpha (first in config) should get scarce fallback weapon');
  assert.equal(betaState.available.sticky_sword, undefined, 'Beta should NOT get fallback when Alpha already claimed the only copy');

  // Total claimed should never exceed global count
  assert.equal(
    getClaimedTotal('sticky_sword'),
    1,
    'total fallback claims for scarce item should not exceed globalCount',
  );

  await flushGearState();
}

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), 'gear-state-test-'));
  try {
    await testRequiredMultiplicityDesiredAndPotionCarryAccounting(tempDir);
    await testBagIncludedInOwnedDeficitRequests(tempDir);
    await testTrimToFitReservesTenSlots(tempDir);
    await testScarcityAssignmentUsesCharacterOrder(tempDir);
    await testCraftableDisplacementKeepsFallbackAvailable(tempDir);
    await testTransitionCompletionDropsFallbackClaim(tempDir);
    await testKeepMapProtectsInventoryFallbackWhenUpgradeMissing(tempDir);
    await testMigrationBackfillsAvailableFromLegacyOwned(tempDir);
    await testRecomputeTriggersOnRevisionAndLevel(tempDir);
    await testToolRequirementsIncludedWithCombatRequirements(tempDir);
    await testToolDeficitNotSatisfiedByWeaponFallback(tempDir);
    await testGearStatePassesPlanningFlagToOptimizer(tempDir);
    await testPublishDesiredOrdersSkipsToolItems(tempDir);
    await testPublishDesiredOrdersCraftOnlyForGloballyMissing(tempDir);
    await testDesiredCraftOrdersWhenAnotherCharacterOwnsCopy(tempDir);
    await testFallbackOverClaimPreventedAcrossCharacters(tempDir);
    console.log('test-gear-state: PASS');
  } finally {
    await flushGearState().catch(() => {});
    _resetGearStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(async (err) => {
  await flushGearState().catch(() => {});
  _resetGearStateForTests();
  console.error(err);
  process.exit(1);
});
