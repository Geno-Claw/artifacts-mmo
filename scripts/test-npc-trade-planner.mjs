#!/usr/bin/env node
import assert from 'node:assert/strict';
process.env.ARTIFACTS_TOKEN ||= 'test-token';
import {
  buildNpcCurrencyPlan,
  maxAffordableQuantity,
  missingCurrencyForQuantity,
} from '../src/services/npc-trade-planner.mjs';
import {
  _resetForTests as resetGameDataForTests,
  _setCachesForTests as setGameDataCachesForTests,
  resolveNpcBuyPlan,
} from '../src/services/game-data.mjs';

function asObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function test_helpers() {
  assert.equal(maxAffordableQuantity(3, 10), 3);
  assert.equal(maxAffordableQuantity(0, 10), 0);
  assert.equal(missingCurrencyForQuantity(5, 3, 12), 3);
  assert.equal(missingCurrencyForQuantity(5, 3, 15), 0);
  console.log('  PASS: helper math functions');
}

function test_gold_only_plan() {
  const shoppingList = [{ code: 'recall_potion', quantity: 10, reason: 'config' }];
  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: () => ({ currency: 'gold', buyPrice: 2 }),
    getCarried: () => 5,
    getBank: () => 20,
  });

  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.items[0], {
    code: 'recall_potion',
    quantity: 10,
    reason: 'config',
    currency: 'gold',
    unitPrice: 2,
    totalCost: 20,
  });
  assert.deepEqual(asObject(plan.neededFromBank), { gold: 15 });
  console.log('  PASS: gold-only planning remains correct');
}

function test_item_currency_inventory_only() {
  const shoppingList = [{ code: 'hard_leather', quantity: 5, reason: 'config' }];
  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: () => ({ currency: 'cowhide', buyPrice: 3 }),
    getCarried: () => 12,
    getBank: () => 0,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].quantity, 4);
  assert.equal(plan.items[0].totalCost, 12);
  assert.deepEqual(asObject(plan.neededFromBank), { cowhide: 0 });
  console.log('  PASS: item-currency planning from carried inventory');
}

function test_item_currency_with_bank() {
  const shoppingList = [{ code: 'hard_leather', quantity: 5, reason: 'config' }];
  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: () => ({ currency: 'cowhide', buyPrice: 3 }),
    getCarried: () => 3,
    getBank: () => 20,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].quantity, 5);
  assert.equal(plan.items[0].totalCost, 15);
  assert.deepEqual(asObject(plan.neededFromBank), { cowhide: 12 });
  console.log('  PASS: item-currency planning with bank contribution');
}

function test_mixed_currencies() {
  const shoppingList = [
    { code: 'recall_potion', quantity: 2, reason: 'config' },
    { code: 'hard_leather', quantity: 4, reason: 'order' },
  ];
  const offers = new Map([
    ['recall_potion', { currency: 'gold', buyPrice: 10 }],
    ['hard_leather', { currency: 'cowhide', buyPrice: 3 }],
  ]);

  const carried = new Map([['gold', 5], ['cowhide', 2]]);
  const bank = new Map([['gold', 20], ['cowhide', 10]]);
  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: (code) => offers.get(code),
    getCarried: (currency) => carried.get(currency) || 0,
    getBank: (currency) => bank.get(currency) || 0,
  });

  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].quantity, 2);
  assert.equal(plan.items[1].quantity, 4);
  assert.deepEqual(asObject(plan.neededFromBank), { cowhide: 10, gold: 15 });
  console.log('  PASS: mixed-currency planning');
}

function test_priority_with_shared_currency() {
  const shoppingList = [
    { code: 'item_a', quantity: 2, reason: 'first' },
    { code: 'item_b', quantity: 10, reason: 'second' },
  ];
  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: () => ({ currency: 'cowhide', buyPrice: 3 }),
    getCarried: () => 4,
    getBank: () => 6, // total 10 currency
  });

  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].code, 'item_a');
  assert.equal(plan.items[0].quantity, 2); // costs 6, leaves 4
  assert.equal(plan.items[1].code, 'item_b');
  assert.equal(plan.items[1].quantity, 1); // remaining 4 only buys one
  console.log('  PASS: list priority preserved for shared currency budget');
}

function test_invalid_offers_skipped() {
  const shoppingList = [
    { code: 'bad_1', quantity: 10, reason: 'config' },
    { code: 'bad_2', quantity: 10, reason: 'config' },
    { code: 'good_1', quantity: 2, reason: 'config' },
  ];
  const offers = new Map([
    ['bad_1', { currency: '', buyPrice: 1 }],
    ['bad_2', { currency: 'gold', buyPrice: 0 }],
    ['good_1', { currency: 'gold', buyPrice: 4 }],
  ]);

  const plan = buildNpcCurrencyPlan(shoppingList, {
    getOffer: (code) => offers.get(code),
    getCarried: () => 0,
    getBank: () => 12,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].code, 'good_1');
  assert.equal(plan.items[0].quantity, 2);
  console.log('  PASS: invalid offers are safely ignored');
}

function test_resolveNpcBuyPlan_gold_currency_skips_bank_gold() {
  resetGameDataForTests();
  setGameDataCachesForTests({
    items: [
      ['healing_rune', { code: 'healing_rune', type: 'rune', level: 20 }],
    ],
    npcBuyOffers: [
      ['rune_vendor', [
        ['healing_rune', { code: 'healing_rune', currency: 'gold', buyPrice: 200 }],
      ]],
    ],
  });

  const plan = resolveNpcBuyPlan('healing_rune', 1);
  assert.ok(Array.isArray(plan), 'gold-backed npc buy plan should resolve');
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], {
    type: 'npc_trade',
    itemCode: 'healing_rune',
    npcCode: 'rune_vendor',
    currency: 'gold',
    buyPrice: 200,
    quantity: 1,
  });
  assert.equal(
    plan.some((step) => step.type === 'bank' && step.itemCode === 'gold'),
    false,
    'gold-backed npc buy plans should not create synthetic bank gold dependencies',
  );
  console.log('  PASS: gold-backed npc buy plan skips bank gold dependency');
}

function test_resolveNpcBuyPlan_item_currency_recurses() {
  resetGameDataForTests();
  setGameDataCachesForTests({
    items: [
      ['greater_healing_rune', { code: 'greater_healing_rune', type: 'rune', level: 40 }],
    ],
    resources: [
      ['sand_vein', {
        code: 'sand_vein',
        skill: 'mining',
        level: 15,
        drops: [{ code: 'sandwhisper_coin' }],
      }],
    ],
    npcBuyOffers: [
      ['sandwhisper_trader', [
        ['greater_healing_rune', { code: 'greater_healing_rune', currency: 'sandwhisper_coin', buyPrice: 30 }],
      ]],
    ],
  });

  const plan = resolveNpcBuyPlan('greater_healing_rune', 2);
  assert.ok(Array.isArray(plan), 'item-currency npc buy plan should resolve');
  assert.deepEqual(plan[0], {
    type: 'gather',
    itemCode: 'sandwhisper_coin',
    resource: {
      code: 'sand_vein',
      skill: 'mining',
      level: 15,
      drops: [{ code: 'sandwhisper_coin' }],
    },
    quantity: 60,
  });
  assert.deepEqual(plan[1], {
    type: 'npc_trade',
    itemCode: 'greater_healing_rune',
    npcCode: 'sandwhisper_trader',
    currency: 'sandwhisper_coin',
    buyPrice: 30,
    quantity: 2,
  });
  console.log('  PASS: item-currency npc buy plan still expands recursively');
}

console.log('NPC Trade Planner Tests:');
test_helpers();
test_gold_only_plan();
test_item_currency_inventory_only();
test_item_currency_with_bank();
test_mixed_currencies();
test_priority_with_shared_currency();
test_invalid_offers_skipped();
test_resolveNpcBuyPlan_gold_currency_skips_bank_gold();
test_resolveNpcBuyPlan_item_currency_recurses();
resetGameDataForTests();
console.log('All NPC trade planner tests passed!');
