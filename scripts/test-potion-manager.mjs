#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const potionManager = await import('../src/services/potion-manager.mjs');

const {
  prepareCombatPotions,
  _rankUtility1ForTests,
  _rankUtility2ForTests,
  _setDepsForTests,
  _resetForTests,
} = potionManager;

function makeCandidate(code, effects, level = 1) {
  return {
    code,
    item: {
      code,
      type: 'utility',
      subtype: 'potion',
      level,
      effects,
      conditions: [],
    },
  };
}

function makeCtx(char, settings = {}) {
  return {
    name: char.name || 'Tester',
    get() {
      return char;
    },
    settings() {
      return settings;
    },
    itemCount(code) {
      const slot = (char.inventory || []).find(s => s.code === code);
      return slot ? slot.quantity : 0;
    },
    hasItem(code, qty = 1) {
      return this.itemCount(code) >= qty;
    },
    inventoryCount() {
      return (char.inventory || []).reduce((sum, s) => sum + (s.code ? s.quantity : 0), 0);
    },
    inventoryCapacity() {
      return char.inventory_max_items || 100;
    },
    async refresh() {},
    applyActionResult() {},
  };
}

function upsertInventory(char, code, quantity) {
  if (!code || quantity === 0) return;
  const inv = char.inventory || (char.inventory = []);
  const row = inv.find(s => s.code === code);
  if (!row) {
    if (quantity > 0) inv.push({ code, quantity });
    return;
  }
  row.quantity += quantity;
  if (row.quantity <= 0) {
    const idx = inv.indexOf(row);
    inv.splice(idx, 1);
  }
}

async function testUtility1PrefersRestore() {
  const candidates = [
    makeCandidate('restore_small', [{ code: 'restore', value: 30 }], 5),
    makeCandidate('restore_big', [{ code: 'restore', value: 200 }], 40),
    makeCandidate('splash_mid', [{ code: 'splash_restore', value: 150 }], 30),
  ];
  const char = { hp: 200, max_hp: 200, attack_fire: 20, initiative: 10 };
  const monster = { hp: 200, attack_fire: 10, initiative: 1 };
  const selected = _rankUtility1ForTests(candidates, char, monster);
  assert.equal(selected.code, 'restore_big', 'utility1 should pick highest restore');
}

async function testUtility1FallsBackToSplash() {
  const candidates = [
    makeCandidate('splash_small', [{ code: 'splash_restore', value: 120 }], 20),
    makeCandidate('splash_big', [{ code: 'splash_restore', value: 200 }], 40),
    makeCandidate('boost', [{ code: 'boost_dmg_fire', value: 10 }], 30),
  ];
  const char = { hp: 200, max_hp: 200, attack_fire: 20, initiative: 10 };
  const monster = { hp: 200, attack_fire: 10, initiative: 1 };
  const selected = _rankUtility1ForTests(candidates, char, monster);
  assert.equal(selected.code, 'splash_big', 'utility1 should pick highest splash_restore when no restore exists');
}

async function testUtility1FallsBackToSimulation() {
  const candidates = [
    makeCandidate('dmg_boost', [{ code: 'boost_dmg_fire', value: 10 }], 10),
    makeCandidate('hp_boost', [{ code: 'boost_hp', value: 200 }], 10),
  ];
  const char = {
    hp: 120, max_hp: 120, initiative: 10, critical_strike: 0,
    attack_fire: 30, attack_earth: 0, attack_water: 0, attack_air: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
    dmg: 0, dmg_fire: 0, dmg_earth: 0, dmg_water: 0, dmg_air: 0,
  };
  const monster = {
    hp: 240, initiative: 1, critical_strike: 0,
    attack_fire: 45, attack_earth: 0, attack_water: 0, attack_air: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
  };
  const selected = _rankUtility1ForTests(candidates, char, monster);
  assert.equal(selected.code, 'hp_boost', 'utility1 sim fallback should pick better simulated potion');
}

async function testUtility2ExcludesUtility1() {
  const candidates = [
    makeCandidate('restore_big', [{ code: 'restore', value: 200 }], 40),
    makeCandidate('boost_fire', [{ code: 'boost_dmg_fire', value: 20 }], 40),
    makeCandidate('res_fire', [{ code: 'boost_res_fire', value: 10 }], 40),
  ];
  const char = {
    hp: 250, max_hp: 250, initiative: 20, critical_strike: 0,
    attack_fire: 45, attack_earth: 0, attack_water: 0, attack_air: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
    dmg: 0, dmg_fire: 0, dmg_earth: 0, dmg_water: 0, dmg_air: 0,
  };
  const monster = {
    hp: 300, initiative: 5, critical_strike: 0,
    attack_fire: 35, attack_earth: 0, attack_water: 0, attack_air: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
  };
  const utility1 = _rankUtility1ForTests(candidates, char, monster);
  const utility2 = _rankUtility2ForTests(candidates, utility1.code, char, monster);
  assert.notEqual(utility2?.code, utility1.code, 'utility2 must not overlap utility1 code');

  const noneLeft = _rankUtility2ForTests([candidates[0]], candidates[0].code, char, monster);
  assert.equal(noneLeft, null, 'utility2 should be null when no non-overlapping candidates exist');
}

async function testRefillWhenBelowThreshold() {
  const char = {
    name: 'RefillTest',
    level: 40,
    hp: 300,
    max_hp: 300,
    initiative: 10,
    critical_strike: 0,
    attack_fire: 20,
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
    utility1_slot: 'greater_health_potion',
    utility1_slot_quantity: 2,
    utility2_slot: '',
    utility2_slot_quantity: 0,
    inventory_max_items: 100,
    inventory: [],
  };
  const ctx = makeCtx(char, {
    potions: {
      enabled: true,
      combat: { enabled: true, refillBelow: 5, targetQuantity: 20 },
    },
  });

  const potionItem = {
    code: 'greater_health_potion',
    type: 'utility',
    subtype: 'potion',
    level: 40,
    effects: [{ code: 'restore', value: 200 }],
    conditions: [],
  };
  const monsters = new Map([['wolf', { code: 'wolf', hp: 200, initiative: 1, attack_fire: 10, attack_earth: 0, attack_water: 0, attack_air: 0, res_fire: 0, res_earth: 0, res_water: 0, res_air: 0, critical_strike: 0 }]]);
  const items = new Map([
    [potionItem.code, potionItem],
  ]);
  const withdrawCalls = [];
  const equipCalls = [];

  _setDepsForTests({
    gameData: {
      getMonster(code) { return monsters.get(code) || null; },
      async getBankItems() { return new Map([[potionItem.code, 100]]); },
      findItems() { return [potionItem]; },
      getItem(code) { return items.get(code) || null; },
    },
    canUseItem: () => true,
    withdrawBankItems: async (_ctx, rows) => {
      withdrawCalls.push(...rows);
      for (const row of rows) upsertInventory(char, row.code, row.quantity);
      return { withdrawn: rows.map(r => ({ code: r.code, quantity: r.quantity })), skipped: [], failed: [] };
    },
    api: {
      async equipItem(slot, code, _name, quantity) {
        equipCalls.push({ slot, code, quantity });
        upsertInventory(char, code, -quantity);
        char[`${slot}_slot`] = code;
        char[`${slot}_slot_quantity`] = (char[`${slot}_slot_quantity`] || 0) + quantity;
        return { cooldown: { remaining_seconds: 0 } };
      },
      async unequipItem() {
        throw new Error('unequip should not be used in refill test');
      },
      async waitForCooldown() {},
    },
  });

  await prepareCombatPotions(ctx, 'wolf');
  assert.ok(withdrawCalls.some(c => c.code === potionItem.code), 'should withdraw potion to refill');
  assert.ok(equipCalls.some(c => c.slot === 'utility1'), 'should re-equip utility1 for refill');
  assert.equal(char.utility1_slot_quantity, 20, 'utility1 should be topped up to target quantity');
}

async function testRespectNonPotionUtility() {
  const char = {
    name: 'PreserveUtility',
    level: 40,
    hp: 300,
    max_hp: 300,
    initiative: 10,
    critical_strike: 0,
    attack_fire: 20,
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
    utility1_slot: 'lucky_charm',
    utility1_slot_quantity: 1,
    utility2_slot: '',
    utility2_slot_quantity: 0,
    inventory_max_items: 100,
    inventory: [{ code: 'greater_health_potion', quantity: 5 }],
  };
  const ctx = makeCtx(char, {
    potions: {
      enabled: true,
      combat: { enabled: true, respectNonPotionUtility: true, refillBelow: 5, targetQuantity: 20 },
    },
  });

  const potionItem = {
    code: 'greater_health_potion',
    type: 'utility',
    subtype: 'potion',
    level: 40,
    effects: [{ code: 'restore', value: 200 }],
    conditions: [],
  };
  const luckyCharm = {
    code: 'lucky_charm',
    type: 'utility',
    subtype: 'charm',
    level: 1,
    effects: [],
    conditions: [],
  };
  const monsters = new Map([['wolf', { code: 'wolf', hp: 200, initiative: 1, attack_fire: 10, attack_earth: 0, attack_water: 0, attack_air: 0, res_fire: 0, res_earth: 0, res_water: 0, res_air: 0, critical_strike: 0 }]]);
  const items = new Map([
    [potionItem.code, potionItem],
    [luckyCharm.code, luckyCharm],
  ]);
  const unequipCalls = [];

  _setDepsForTests({
    gameData: {
      getMonster(code) { return monsters.get(code) || null; },
      async getBankItems() { return new Map([[potionItem.code, 100]]); },
      findItems() { return [potionItem]; },
      getItem(code) { return items.get(code) || null; },
    },
    canUseItem: () => true,
    withdrawBankItems: async () => ({ withdrawn: [], skipped: [], failed: [] }),
    api: {
      async equipItem() { throw new Error('equip should be skipped for non-potion utility slot'); },
      async unequipItem(slot) {
        unequipCalls.push(slot);
        return { cooldown: { remaining_seconds: 0 } };
      },
      async waitForCooldown() {},
    },
  });

  await prepareCombatPotions(ctx, 'wolf');
  assert.equal(char.utility1_slot, 'lucky_charm', 'non-potion utility should remain equipped');
  assert.equal(unequipCalls.length, 0, 'non-potion utility should not be unequipped');
}

async function testSkipsPotionsForDisallowedMonsterType() {
  const char = {
    name: 'TypeFilter',
    level: 40,
    hp: 300,
    max_hp: 300,
    initiative: 10,
    critical_strike: 0,
    attack_fire: 20,
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
    utility1_slot: '',
    utility1_slot_quantity: 0,
    utility2_slot: '',
    utility2_slot_quantity: 0,
    inventory_max_items: 100,
    inventory: [{ code: 'greater_health_potion', quantity: 20 }],
  };
  // Only use potions for elite and boss
  const ctx = makeCtx(char, {
    potions: {
      enabled: true,
      combat: { enabled: true, monsterTypes: ['elite', 'boss'] },
    },
  });

  const potionItem = {
    code: 'greater_health_potion',
    type: 'utility',
    subtype: 'potion',
    level: 40,
    effects: [{ code: 'restore', value: 200 }],
    conditions: [],
  };
  const normalWolf = { code: 'wolf', type: 'normal', hp: 200, initiative: 1, attack_fire: 10, attack_earth: 0, attack_water: 0, attack_air: 0, res_fire: 0, res_earth: 0, res_water: 0, res_air: 0, critical_strike: 0 };
  const eliteWolf = { ...normalWolf, code: 'elite_wolf', type: 'elite' };

  const equipCalls = [];

  _setDepsForTests({
    gameData: {
      getMonster(code) {
        if (code === 'wolf') return normalWolf;
        if (code === 'elite_wolf') return eliteWolf;
        return null;
      },
      async getBankItems() { return new Map([[potionItem.code, 100]]); },
      findItems() { return [potionItem]; },
      getItem(code) { return code === potionItem.code ? potionItem : null; },
    },
    canUseItem: () => true,
    withdrawBankItems: async () => ({ withdrawn: [], skipped: [], failed: [] }),
    api: {
      async equipItem(slot, code, _name, quantity) {
        equipCalls.push({ slot, code, quantity });
        char[`${slot}_slot`] = code;
        char[`${slot}_slot_quantity`] = quantity;
        return { cooldown: { remaining_seconds: 0 } };
      },
      async unequipItem() { return { cooldown: { remaining_seconds: 0 } }; },
      async waitForCooldown() {},
    },
  });

  // Normal monster — should skip potions
  const normalResult = await prepareCombatPotions(ctx, 'wolf');
  assert.equal(normalResult.selected, null, 'should skip potions for normal monster');
  assert.equal(equipCalls.length, 0, 'should not equip anything for normal monster');

  // Elite monster — should use potions
  const eliteResult = await prepareCombatPotions(ctx, 'elite_wolf');
  assert.ok(eliteResult.selected, 'should prepare potions for elite monster');
}

async function run() {
  await testUtility1PrefersRestore();
  await testUtility1FallsBackToSplash();
  await testUtility1FallsBackToSimulation();
  await testUtility2ExcludesUtility1();
  await testRefillWhenBelowThreshold();
  await testRespectNonPotionUtility();
  await testSkipsPotionsForDisallowedMonsterType();

  _resetForTests();
  console.log('potion-manager tests passed');
}

run().catch((err) => {
  _resetForTests();
  console.error(err);
  process.exit(1);
});
