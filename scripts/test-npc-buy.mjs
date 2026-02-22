#!/usr/bin/env node
/**
 * Tests for NPC buy config service and EventRoutine NPC shopping list.
 */
import assert from 'node:assert/strict';
import { loadNpcBuyList, getItemsForNpc, _buyList } from '../src/services/npc-buy-config.mjs';

// --- npc-buy-config tests ---

function test_loadNpcBuyList_basic() {
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [
        { code: 'minor_health_potion', maxTotal: 200 },
        { code: 'backpack', maxTotal: 5 },
      ],
      fish_merchant: [
        { code: 'gudgeon', maxTotal: 100 },
      ],
    },
  });

  const nomadic = getItemsForNpc('nomadic_merchant');
  assert.equal(nomadic.length, 2);
  assert.equal(nomadic[0].code, 'minor_health_potion');
  assert.equal(nomadic[0].maxTotal, 200);
  assert.equal(nomadic[1].code, 'backpack');

  const fish = getItemsForNpc('fish_merchant');
  assert.equal(fish.length, 1);
  assert.equal(fish[0].code, 'gudgeon');

  // Unknown NPC returns empty
  const unknown = getItemsForNpc('unknown_npc');
  assert.equal(unknown.length, 0);

  console.log('  PASS: loadNpcBuyList basic loading');
}

function test_loadNpcBuyList_anyKey() {
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [
        { code: 'backpack', maxTotal: 5 },
      ],
      _any: [
        { code: 'recall_potion', maxTotal: 50 },
      ],
    },
  });

  // nomadic_merchant gets both specific + _any
  const nomadic = getItemsForNpc('nomadic_merchant');
  assert.equal(nomadic.length, 2);
  assert.equal(nomadic[0].code, 'backpack');
  assert.equal(nomadic[1].code, 'recall_potion');

  // fish_merchant only gets _any
  const fish = getItemsForNpc('fish_merchant');
  assert.equal(fish.length, 1);
  assert.equal(fish[0].code, 'recall_potion');

  console.log('  PASS: _any key merges into all NPCs');
}

function test_loadNpcBuyList_anyDedupes() {
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [
        { code: 'recall_potion', maxTotal: 100 },
      ],
      _any: [
        { code: 'recall_potion', maxTotal: 50 },  // same item, different maxTotal
        { code: 'other_item', maxTotal: 10 },
      ],
    },
  });

  const nomadic = getItemsForNpc('nomadic_merchant');
  assert.equal(nomadic.length, 2);
  // Specific entry takes priority
  assert.equal(nomadic[0].code, 'recall_potion');
  assert.equal(nomadic[0].maxTotal, 100);
  assert.equal(nomadic[1].code, 'other_item');

  console.log('  PASS: _any deduplicates with specific entries');
}

function test_loadNpcBuyList_empty() {
  loadNpcBuyList({});
  assert.equal(getItemsForNpc('nomadic_merchant').length, 0);

  loadNpcBuyList(null);
  assert.equal(getItemsForNpc('nomadic_merchant').length, 0);

  loadNpcBuyList({ npcBuyList: null });
  assert.equal(getItemsForNpc('nomadic_merchant').length, 0);

  console.log('  PASS: handles empty/null config gracefully');
}

function test_loadNpcBuyList_validation() {
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [
        { code: '', maxTotal: 100 },           // empty code — skipped
        { code: 'valid_item', maxTotal: 0 },    // zero maxTotal — clamped to 1
        { code: 'another', maxTotal: -5 },       // negative — clamped to 1
        { maxTotal: 100 },                        // missing code — skipped
        { code: 'good_item', maxTotal: 50 },     // valid
      ],
    },
  });

  const items = getItemsForNpc('nomadic_merchant');
  assert.equal(items.length, 3);  // valid_item (clamped), another (clamped), good_item
  assert.equal(items[0].code, 'valid_item');
  assert.equal(items[0].maxTotal, 1);
  assert.equal(items[1].code, 'another');
  assert.equal(items[1].maxTotal, 1);
  assert.equal(items[2].code, 'good_item');
  assert.equal(items[2].maxTotal, 50);

  console.log('  PASS: validates and clamps config entries');
}

function test_loadNpcBuyList_hotReload() {
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [{ code: 'item_a', maxTotal: 10 }],
    },
  });
  assert.equal(getItemsForNpc('nomadic_merchant').length, 1);

  // Hot-reload with different config
  loadNpcBuyList({
    npcBuyList: {
      nomadic_merchant: [
        { code: 'item_b', maxTotal: 20 },
        { code: 'item_c', maxTotal: 30 },
      ],
    },
  });
  const items = getItemsForNpc('nomadic_merchant');
  assert.equal(items.length, 2);
  assert.equal(items[0].code, 'item_b');

  console.log('  PASS: hot-reload replaces old config');
}

// --- Run ---

console.log('NPC Buy Config Tests:');
test_loadNpcBuyList_basic();
test_loadNpcBuyList_anyKey();
test_loadNpcBuyList_anyDedupes();
test_loadNpcBuyList_empty();
test_loadNpcBuyList_validation();
test_loadNpcBuyList_hotReload();
console.log('All NPC buy config tests passed!');
