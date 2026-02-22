#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const potionManager = await import('../src/services/potion-manager.mjs');
const gearState = await import('../src/services/gear-state.mjs');

const {
  computeDesiredPotionsForMonsters,
  _setDepsForTests: setPotionDeps,
  _resetForTests: resetPotionDeps,
} = potionManager;

const {
  _resetGearStateForTests,
  _setDepsForTests: setGearStateDeps,
  flushGearState,
  getCharacterGearState,
  initializeGearState,
  publishDesiredOrdersForCharacter,
  refreshGearState,
  registerContext,
} = gearState;

// ── test helpers ──

function makePotion(code, effects, level = 1) {
  return {
    code,
    type: 'utility',
    subtype: 'potion',
    level,
    effects: effects.map(e => ({ code: e.code || e.name, value: e.value })),
    conditions: [],
  };
}

function makeMonster(code, overrides = {}) {
  return {
    code,
    hp: 200,
    initiative: 5,
    critical_strike: 0,
    attack_fire: 20, attack_earth: 0, attack_water: 0, attack_air: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
    effects: [],
    ...overrides,
  };
}

function makeCtx({
  name,
  level = 20,
  capacity = 100,
  equipped = {},
  utility = {},
} = {}) {
  const char = {
    name,
    level,
    hp: 300,
    max_hp: 300,
    initiative: 10,
    critical_strike: 0,
    attack_fire: 30,
    attack_earth: 0,
    attack_water: 0,
    attack_air: 0,
    res_fire: 0,
    res_earth: 0,
    res_water: 0,
    res_air: 0,
    dmg: 0,
    dmg_fire: 0,
    dmg_earth: 0,
    dmg_water: 0,
    dmg_air: 0,
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
    inventory_max_items: capacity,
    inventory: [],
  };

  return {
    name,
    get() { return char; },
    settings() { return {}; },
    setLevel(l) { char.level = l; },
    inventoryCapacity() { return capacity; },
    inventoryCount() { return 0; },
    itemCount() { return 0; },
    hasItem() { return false; },
  };
}

function mapLoadout(slots = {}) {
  return new Map(Object.entries(slots).filter(([, code]) => !!code));
}

// ── computeDesiredPotionsForMonsters tests ──

async function testDesiredPotionsReturnsSetOfCodes() {
  const healPotion = makePotion('heal_pot', [{ code: 'restore', value: 100 }], 10);
  const dmgPotion = makePotion('fire_pot', [{ code: 'boost_dmg_fire', value: 15 }], 10);
  const wolf = makeMonster('wolf', { level: 10 });

  setPotionDeps({
    gameData: {
      findItems: () => [healPotion, dmgPotion],
      getItem: (code) => [healPotion, dmgPotion].find(p => p.code === code) || null,
      getMonster: (code) => (code === 'wolf' ? wolf : null),
    },
    canUseItem: () => true,
    simulateCombat: (stats, monster) => ({
      win: true,
      turns: 8,
      hpLostPercent: 20,
      remainingHp: stats.max_hp * 0.8,
    }),
  });

  const ctx = makeCtx({ name: 'Test', level: 10 });
  const result = computeDesiredPotionsForMonsters(ctx, ['wolf']);

  assert.ok(result instanceof Set, 'should return a Set');
  assert.ok(result.size > 0, 'should find at least one desired potion');
  assert.ok(result.has('heal_pot'), 'should include restore potion as utility1');
}

async function testDesiredPotionsUnionAcrossMonsters() {
  const healPotion = makePotion('heal_pot', [{ code: 'restore', value: 100 }], 10);
  const antiPotion = makePotion('anti_pot', [{ code: 'antipoison', value: 50 }], 10);
  const dmgPotion = makePotion('fire_pot', [{ code: 'boost_dmg_fire', value: 15 }], 10);
  const allPotions = [healPotion, antiPotion, dmgPotion];

  const wolf = makeMonster('wolf', { level: 5 });
  const snake = makeMonster('snake', { level: 8, effects: [{ code: 'poison', value: 30 }] });

  setPotionDeps({
    gameData: {
      findItems: () => allPotions,
      getItem: (code) => allPotions.find(p => p.code === code) || null,
      getMonster: (code) => {
        if (code === 'wolf') return wolf;
        if (code === 'snake') return snake;
        return null;
      },
    },
    canUseItem: () => true,
    simulateCombat: (stats, monster, opts) => {
      // Give antipoison a higher score against snake (has poison)
      const utilities = opts?.utilities || [];
      const hasAntipoison = utilities.some(u =>
        u.effects?.some(e => (e.code || e.name) === 'antipoison'),
      );
      const isPoison = monster === snake;
      const bonus = (isPoison && hasAntipoison) ? 20 : 0;
      return {
        win: true,
        turns: 8,
        hpLostPercent: Math.max(5, 30 - bonus),
        remainingHp: stats.max_hp * 0.7,
      };
    },
  });

  const ctx = makeCtx({ name: 'Test', level: 10 });
  const result = computeDesiredPotionsForMonsters(ctx, ['wolf', 'snake']);

  assert.ok(result instanceof Set, 'should return a Set');
  // Should have the restore potion (utility1 for both) plus at least one more
  assert.ok(result.has('heal_pot'), 'should include heal_pot (restore is always utility1)');
  assert.ok(result.size >= 2, 'should include potions from both monsters');
}

async function testDesiredPotionsEmptyWhenNoPotions() {
  setPotionDeps({
    gameData: {
      findItems: () => [],
      getItem: () => null,
      getMonster: () => makeMonster('wolf'),
    },
    canUseItem: () => true,
  });

  const ctx = makeCtx({ name: 'Test', level: 10 });
  const result = computeDesiredPotionsForMonsters(ctx, ['wolf']);

  assert.ok(result instanceof Set);
  assert.equal(result.size, 0, 'should be empty when no potions exist');
}

async function testDesiredPotionsEmptyWhenNoMonsters() {
  setPotionDeps({
    gameData: {
      findItems: () => [makePotion('heal', [{ code: 'restore', value: 50 }])],
      getItem: () => null,
      getMonster: () => null,
    },
    canUseItem: () => true,
  });

  const ctx = makeCtx({ name: 'Test', level: 10 });
  const result = computeDesiredPotionsForMonsters(ctx, ['nonexistent']);

  assert.ok(result instanceof Set);
  assert.equal(result.size, 0, 'should be empty when monster not found');
}

async function testDesiredPotionsRespectsCanUseItem() {
  const lowPotion = makePotion('low_heal', [{ code: 'restore', value: 30 }], 1);
  const highPotion = makePotion('high_heal', [{ code: 'restore', value: 200 }], 50);

  setPotionDeps({
    gameData: {
      findItems: () => [lowPotion, highPotion],
      getItem: (code) => [lowPotion, highPotion].find(p => p.code === code) || null,
      getMonster: () => makeMonster('wolf'),
    },
    canUseItem: (item, char) => item.level <= char.level,
    simulateCombat: () => ({
      win: true,
      turns: 8,
      hpLostPercent: 20,
      remainingHp: 200,
    }),
  });

  const ctx = makeCtx({ name: 'Test', level: 10 });
  const result = computeDesiredPotionsForMonsters(ctx, ['wolf']);

  assert.ok(result.has('low_heal'), 'should include usable potion');
  assert.ok(!result.has('high_heal'), 'should exclude potion above character level');
}

// ── gear-state integration: simulation-derived potion orders ──

async function testGearStateSimDerivedPotionRequirements(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'PotionSim',
    level: 20,
    capacity: 100,
  });

  const potionCodes = new Set(['heal_pot', 'fire_pot']);
  const counts = new Map([
    ['combat_blade', 1],
    ['heal_pot', 100], // plenty of heal_pot
    ['fire_pot', 0],   // no fire_pot — should show as desired
  ]);

  setGearStateDeps({
    gameDataSvc: {
      findMonstersByLevel(maxLevel) {
        return maxLevel >= 10 ? [{ code: 'wolf', level: 10 }] : [];
      },
      getItem(code) {
        if (code === 'fire_pot') {
          return { code, type: 'utility', subtype: 'potion', level: 5, craft: { skill: 'alchemy', level: 5 } };
        }
        return code ? { code, level: 5 } : null;
      },
      getResourceForDrop() { return null; },
      getMonsterForDrop() { return null; },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'combat_blade' }),
      simResult: {
        win: true,
        hpLostPercent: 20,
        turns: 5,
        remainingHp: 200,
      },
    }),
    getBankRevisionFn: () => 1,
    globalCountFn: (code) => counts.get(code) || 0,
    computeDesiredPotionsFn: (_ctx, monsterCodes) => {
      // Mock: return predetermined desired potions when monsters include 'wolf'
      if (monsterCodes.includes('wolf')) return potionCodes;
      return new Set();
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-potion-sim.json'),
    characters: [{
      name: 'PotionSim',
      settings: {
        potions: {
          enabled: true,
          combat: { enabled: true, targetQuantity: 20, poisonBias: true },
        },
      },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: true, createOrders: true } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const state = getCharacterGearState('PotionSim');
  assert.ok(state, 'character state should exist');

  // heal_pot: 100 available, 20 needed → assigned 20, no desired
  assert.equal(state.assigned.heal_pot, 20, 'heal_pot should be assigned at targetQuantity');
  assert.equal(state.desired.heal_pot, undefined, 'heal_pot should not be desired (plenty available)');

  // fire_pot: 0 available, 20 needed → desired 20
  assert.equal(state.desired.fire_pot, 20, 'fire_pot should be desired (none available)');
  assert.equal(state.assigned.fire_pot, undefined, 'fire_pot should not be assigned (none available)');

  // required should have both
  assert.equal(state.required.heal_pot, 20, 'required should include heal_pot');
  assert.equal(state.required.fire_pot, 20, 'required should include fire_pot');

  await flushGearState();
}

async function testGearStatePotionOrdersPublished(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({
    name: 'PotionOrder',
    level: 20,
    capacity: 50,
  });

  const created = [];

  setGearStateDeps({
    gameDataSvc: {
      findMonstersByLevel(maxLevel) {
        return maxLevel >= 10 ? [{ code: 'wolf', level: 10 }] : [];
      },
      getItem(code) {
        if (code === 'craft_potion') {
          return { code, type: 'utility', subtype: 'potion', level: 5, craft: { skill: 'alchemy', level: 5 } };
        }
        return code ? { code, level: 5 } : null;
      },
      getResourceForDrop() { return null; },
      getMonsterForDrop() { return null; },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'blade' }),
      simResult: { win: true, hpLostPercent: 20, turns: 5, remainingHp: 200 },
    }),
    getBankRevisionFn: () => 1,
    globalCountFn: () => 0,
    computeDesiredPotionsFn: () => new Set(['craft_potion']),
    createOrMergeOrderFn: (request) => {
      created.push(request);
      return { id: `order-${request.itemCode}` };
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-potion-orders.json'),
    characters: [{
      name: 'PotionOrder',
      settings: {
        potions: {
          enabled: true,
          combat: { enabled: true, targetQuantity: 20, poisonBias: true },
        },
      },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: true, createOrders: true } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const count = publishDesiredOrdersForCharacter('PotionOrder');
  assert.equal(count, 1, 'should create 1 order for missing potion');

  const potionOrder = created.find(o => o.itemCode === 'craft_potion');
  assert.ok(potionOrder, 'should create order for craft_potion');
  assert.equal(potionOrder.sourceType, 'craft', 'should resolve craft source');
  assert.equal(potionOrder.craftSkill, 'alchemy', 'should set alchemy as craft skill');
  assert.equal(potionOrder.quantity, 20, 'order quantity should match desired qty');
  assert.equal(potionOrder.requesterName, 'PotionOrder', 'requester should be character name');

  await flushGearState();
}

async function testGearStateNonCraftPotionOrderUsesGeneralResolver(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'DropPotion', level: 20, capacity: 50 });
  const created = [];

  setGearStateDeps({
    gameDataSvc: {
      findMonstersByLevel(maxLevel) {
        return maxLevel >= 10 ? [{ code: 'wolf', level: 10 }] : [];
      },
      getItem(code) {
        // Non-craftable potion (no craft property).
        if (code === 'drop_potion') return { code, type: 'utility', subtype: 'potion', level: 5 };
        return code ? { code, level: 5 } : null;
      },
      getResourceForDrop() { return null; },
      getMonsterForDrop() { return null; },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'blade' }),
      simResult: { win: true, hpLostPercent: 20, turns: 5, remainingHp: 200 },
    }),
    getBankRevisionFn: () => 1,
    globalCountFn: () => 0,
    computeDesiredPotionsFn: () => new Set(['drop_potion']),
    createOrMergeOrderFn: (request) => {
      created.push(request);
      return { id: `order-${request.itemCode}` };
    },
    // General resolver falls back to fight source for this potion.
    resolveItemOrderSourceFn: (code) => {
      if (code === 'drop_potion') {
        return {
          sourceType: 'fight',
          sourceCode: 'snake_boss',
          gatherSkill: null,
          craftSkill: null,
          sourceLevel: 15,
        };
      }
      return null;
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-potion-drop-orders.json'),
    characters: [{
      name: 'DropPotion',
      settings: {
        potions: {
          enabled: true,
          combat: { enabled: true, targetQuantity: 10, poisonBias: true },
        },
      },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: true, createOrders: true } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  const count = publishDesiredOrdersForCharacter('DropPotion');
  assert.equal(count, 1, 'should create order via general resolver');

  const order = created.find(o => o.itemCode === 'drop_potion');
  assert.ok(order, 'should create order for drop_potion');
  assert.equal(order.sourceType, 'fight', 'should use fight source type');
  assert.equal(order.sourceCode, 'snake_boss', 'should use resolved source code');

  await flushGearState();
}

async function testDesiredPotionsDisabledWhenPotionsOff(basePath) {
  _resetGearStateForTests();

  const ctx = makeCtx({ name: 'NoPotions', level: 20, capacity: 50 });
  let potionFnCalled = false;

  setGearStateDeps({
    gameDataSvc: {
      findMonstersByLevel(maxLevel) {
        return maxLevel >= 10 ? [{ code: 'wolf', level: 10 }] : [];
      },
      getItem() { return null; },
      getResourceForDrop() { return null; },
      getMonsterForDrop() { return null; },
    },
    optimizeForMonsterFn: async () => ({
      loadout: mapLoadout({ weapon: 'blade' }),
      simResult: { win: true, hpLostPercent: 20, turns: 5, remainingHp: 200 },
    }),
    getBankRevisionFn: () => 1,
    globalCountFn: () => 10,
    computeDesiredPotionsFn: () => {
      potionFnCalled = true;
      return new Set(['should_not_appear']);
    },
  });

  await initializeGearState({
    path: join(basePath, 'gear-potions-disabled.json'),
    characters: [{
      name: 'NoPotions',
      settings: {
        potions: { enabled: false },
      },
      routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
    }],
  });
  registerContext(ctx);
  await refreshGearState({ force: true });

  assert.equal(potionFnCalled, false, 'computeDesiredPotionsFn should not be called when potions disabled');

  const state = getCharacterGearState('NoPotions');
  assert.equal(state.assigned.should_not_appear, undefined, 'no potion should be assigned when disabled');
  assert.equal(state.desired.should_not_appear, undefined, 'no potion should be desired when disabled');

  await flushGearState();
}

// ── runner ──

async function run() {
  // potion-manager unit tests
  await testDesiredPotionsReturnsSetOfCodes();
  await testDesiredPotionsUnionAcrossMonsters();
  await testDesiredPotionsEmptyWhenNoPotions();
  await testDesiredPotionsEmptyWhenNoMonsters();
  await testDesiredPotionsRespectsCanUseItem();
  resetPotionDeps();

  // gear-state integration tests
  const tempDir = mkdtempSync(join(tmpdir(), 'potion-desired-test-'));
  try {
    await testGearStateSimDerivedPotionRequirements(tempDir);
    await testGearStatePotionOrdersPublished(tempDir);
    await testGearStateNonCraftPotionOrderUsesGeneralResolver(tempDir);
    await testDesiredPotionsDisabledWhenPotionsOff(tempDir);
    console.log('test-potion-desired: PASS');
  } finally {
    await flushGearState().catch(() => {});
    _resetGearStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(async (err) => {
  resetPotionDeps();
  await flushGearState().catch(() => {});
  _resetGearStateForTests();
  console.error(err);
  process.exit(1);
});
