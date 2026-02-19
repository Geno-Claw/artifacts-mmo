#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gearState = await import('../src/services/gear-state.mjs');

const {
  _resetGearStateForTests,
  _setDepsForTests,
  flushGearState,
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
  assert.equal(state.required.ruby_ring, 2, 'ring slot multiplicity should be preserved');
  assert.equal(state.owned.minor_health_potion, 4, 'owned should include target potion quantity');
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
  assert.equal(sumObjectValues(state.owned), 3, 'owned carry set should be trimmed to capacity-10 budget');
  assert.deepEqual(
    Object.keys(state.owned).sort(),
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

  assert.equal(alphaState.owned.rare_blade, 1, 'first character in config order should get scarce item');
  assert.equal(alphaState.desired.rare_blade, undefined);
  assert.equal(betaState.owned.rare_blade, undefined);
  assert.equal(betaState.desired.rare_blade, 1, 'later character should receive desired deficit');

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

async function testPublishDesiredOrdersByAcquisitionType(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'CrafterOne', level: 20, capacity: 30 });
  const created = [];

  _setDepsForTests({
    gameDataSvc: {
      ...createBaseGameData([{ code: 'target', level: 20 }]),
      getItem(code) {
        if (code === 'craft_item') {
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
      getResourceForDrop(code) {
        if (code === 'gather_item') {
          return { code: 'oak_node', skill: 'woodcutting', level: 8 };
        }
        return null;
      },
      getMonsterForDrop(code) {
        if (code === 'fight_item') {
          return { monster: { code: 'goblin', level: 6 } };
        }
        return null;
      },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({
        weapon: 'craft_item',
        shield: 'gather_item',
        helmet: 'fight_item',
      }),
      simResult: {
        win: true,
        hpLostPercent: 40,
        turns: 7,
        remainingHp: 60,
      },
    }),
    getBankRevisionFn: () => 5,
    globalCountFn: () => 0,
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
  assert.equal(added, 3, 'three desired deficits should create three source orders');

  const byItem = new Map(created.map(order => [order.itemCode, order]));
  assert.equal(byItem.get('craft_item')?.sourceType, 'craft');
  assert.equal(byItem.get('craft_item')?.sourceCode, 'craft_item');
  assert.equal(byItem.get('craft_item')?.craftSkill, 'gearcrafting');
  assert.equal(byItem.get('craft_item')?.recipeCode, 'gear_state:CrafterOne:craft_item');

  assert.equal(byItem.get('gather_item')?.sourceType, 'gather');
  assert.equal(byItem.get('gather_item')?.sourceCode, 'oak_node');
  assert.equal(byItem.get('gather_item')?.gatherSkill, 'woodcutting');

  assert.equal(byItem.get('fight_item')?.sourceType, 'fight');
  assert.equal(byItem.get('fight_item')?.sourceCode, 'goblin');

  await flushGearState();
}

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), 'gear-state-test-'));
  try {
    await testRequiredMultiplicityDesiredAndPotionCarryAccounting(tempDir);
    await testTrimToFitReservesTenSlots(tempDir);
    await testScarcityAssignmentUsesCharacterOrder(tempDir);
    await testRecomputeTriggersOnRevisionAndLevel(tempDir);
    await testPublishDesiredOrdersByAcquisitionType(tempDir);
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
