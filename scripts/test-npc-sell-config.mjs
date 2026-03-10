#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  _sellList,
  getItemsForNpcSell,
  hasNpcSellItem,
  loadNpcSellList,
} from '../src/services/npc-sell-config.mjs';

function testLoadNpcSellListBasic() {
  loadNpcSellList({
    npcSellList: {
      nomadic_merchant: [
        { code: 'old_boots', keepInBank: 0 },
        { code: 'bone_ring', keepInBank: 2 },
      ],
      fish_merchant: [
        { code: 'cooked_shrimp', keepInBank: 50 },
      ],
    },
  });

  assert.deepEqual(getItemsForNpcSell('nomadic_merchant'), [
    { code: 'old_boots', keepInBank: 0 },
    { code: 'bone_ring', keepInBank: 2 },
  ]);
  assert.deepEqual(getItemsForNpcSell('fish_merchant'), [
    { code: 'cooked_shrimp', keepInBank: 50 },
  ]);
  assert.equal(hasNpcSellItem('old_boots'), true);
  assert.equal(hasNpcSellItem('missing_item'), false);
}

function testAnyMergesAndDedupes() {
  loadNpcSellList({
    npcSellList: {
      _any: [
        { code: 'old_boots', keepInBank: 3 },
        { code: 'feather', keepInBank: 10 },
      ],
      nomadic_merchant: [
        { code: 'old_boots', keepInBank: 1 },
      ],
    },
  });

  assert.deepEqual(getItemsForNpcSell('nomadic_merchant'), [
    { code: 'old_boots', keepInBank: 1 },
    { code: 'feather', keepInBank: 10 },
  ]);
  assert.deepEqual(getItemsForNpcSell('tailor'), [
    { code: 'old_boots', keepInBank: 3 },
    { code: 'feather', keepInBank: 10 },
  ]);
}

function testValidationAndHotReload() {
  loadNpcSellList({
    npcSellList: {
      nomadic_merchant: [
        { code: '', keepInBank: 5 },
        { code: 'old_boots', keepInBank: -2 },
        { code: 'bone_ring', keepInBank: '7' },
      ],
    },
  });

  assert.deepEqual(getItemsForNpcSell('nomadic_merchant'), [
    { code: 'old_boots', keepInBank: 0 },
    { code: 'bone_ring', keepInBank: 7 },
  ]);

  loadNpcSellList({});
  assert.equal(getItemsForNpcSell('nomadic_merchant').length, 0);
  assert.deepEqual(_sellList, {});
}

function run() {
  testLoadNpcSellListBasic();
  testAnyMergesAndDedupes();
  testValidationAndHotReload();
  console.log('test-npc-sell-config: PASS');
}

run();
