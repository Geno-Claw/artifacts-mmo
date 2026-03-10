#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const orderPriority = await import('../src/services/order-priority.mjs');

const {
  _resetForTests,
  _setDepsForTests,
  getOrderClaimBucket,
  getOrderClaimPriority,
  sortOrdersForClaim,
} = orderPriority;

function installGameDataDeps(itemsByCode = new Map()) {
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

  _setDepsForTests({
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

async function testBucketClassification() {
  _resetForTests();
  installGameDataDeps(new Map([
    ['copper_pick', { code: 'copper_pick', type: 'weapon', subtype: 'tool' }],
    ['shrimp', { code: 'shrimp', type: 'resource' }],
    ['iron_sword', { code: 'iron_sword', type: 'weapon' }],
    ['iron_helmet', { code: 'iron_helmet', type: 'helmet' }],
  ]));

  assert.equal(getOrderClaimBucket({ itemCode: 'copper_pick' }), 'tool');
  assert.equal(getOrderClaimBucket({ itemCode: 'shrimp' }), 'resource');
  assert.equal(getOrderClaimBucket({ itemCode: 'iron_sword' }), 'weapon');
  assert.equal(getOrderClaimBucket({ itemCode: 'iron_helmet' }), 'gear');
  assert.equal(getOrderClaimBucket({ itemCode: 'missing_item' }), 'resource', 'unknown items should default to resource bucket');

  assert.equal(getOrderClaimPriority({ itemCode: 'copper_pick' }), 0);
  assert.equal(getOrderClaimPriority({ itemCode: 'shrimp' }), 1);
  assert.equal(getOrderClaimPriority({ itemCode: 'iron_sword' }), 2);
  assert.equal(getOrderClaimPriority({ itemCode: 'iron_helmet' }), 3);
}

async function testSortOrdersByBucketThenFifo() {
  _resetForTests();
  installGameDataDeps(new Map([
    ['tool_old', { code: 'tool_old', type: 'weapon', subtype: 'tool' }],
    ['tool_new', { code: 'tool_new', type: 'weapon', subtype: 'tool' }],
    ['res_old', { code: 'res_old', type: 'resource' }],
    ['res_new', { code: 'res_new', type: 'consumable' }],
    ['weapon_old', { code: 'weapon_old', type: 'weapon' }],
    ['gear_old', { code: 'gear_old', type: 'ring' }],
  ]));

  const input = [
    { id: 'gear_old', itemCode: 'gear_old', createdAtMs: 1 },
    { id: 'tool_new', itemCode: 'tool_new', createdAtMs: 30 },
    { id: 'weapon_old', itemCode: 'weapon_old', createdAtMs: 2 },
    { id: 'res_new', itemCode: 'res_new', createdAtMs: 40 },
    { id: 'res_old', itemCode: 'res_old', createdAtMs: 11 },
    { id: 'tool_old', itemCode: 'tool_old', createdAtMs: 10 },
  ];

  const sorted = sortOrdersForClaim(input);
  assert.deepEqual(
    sorted.map(order => order.id),
    ['tool_old', 'tool_new', 'res_old', 'res_new', 'weapon_old', 'gear_old'],
  );
}

async function testSortPreservesInputAndUsesIdTieBreak() {
  _resetForTests();
  installGameDataDeps(new Map([
    ['tool_a', { code: 'tool_a', type: 'weapon', subtype: 'tool' }],
    ['tool_b', { code: 'tool_b', type: 'weapon', subtype: 'tool' }],
  ]));

  const input = [
    { id: 'b-order', itemCode: 'tool_b', createdAtMs: 100 },
    { id: 'a-order', itemCode: 'tool_a', createdAtMs: 100 },
  ];
  const originalIds = input.map(order => order.id);

  const sorted = sortOrdersForClaim(input);
  assert.deepEqual(sorted.map(order => order.id), ['a-order', 'b-order'], 'same bucket + same createdAt should fall back to id');
  assert.deepEqual(input.map(order => order.id), originalIds, 'sortOrdersForClaim should not mutate input array order');
}

async function run() {
  await testBucketClassification();
  await testSortOrdersByBucketThenFifo();
  await testSortPreservesInputAndUsesIdTieBreak();
  _resetForTests();
  console.log('test-order-priority: PASS');
}

run().catch((err) => {
  _resetForTests();
  console.error(err);
  process.exit(1);
});
