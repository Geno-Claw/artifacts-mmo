#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  _resetForTests,
  _setCachesForTests,
  canSellToNpc,
  findBestNpcSellOffer,
  getNpcSellOffer,
  getNpcSellPrice,
} from '../src/services/game-data.mjs';

function testNpcSellOfferAccessors() {
  _resetForTests();
  _setCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [
        ['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 500 }],
      ]],
      ['fish_merchant', [
        ['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 450 }],
        ['cooked_shrimp', { code: 'cooked_shrimp', currency: 'shell_token', sellPrice: 7 }],
      ]],
    ],
  });

  assert.equal(canSellToNpc('nomadic_merchant', 'old_boots'), true);
  assert.equal(canSellToNpc('nomadic_merchant', 'cooked_shrimp'), false);
  assert.deepEqual(getNpcSellOffer('nomadic_merchant', 'old_boots'), {
    code: 'old_boots',
    currency: 'gold',
    sellPrice: 500,
  });
  assert.equal(getNpcSellPrice('fish_merchant', 'cooked_shrimp'), 7);
  assert.deepEqual(findBestNpcSellOffer('old_boots'), {
    npcCode: 'nomadic_merchant',
    currency: 'gold',
    sellPrice: 500,
  });
  assert.deepEqual(findBestNpcSellOffer('cooked_shrimp'), {
    npcCode: 'fish_merchant',
    currency: 'shell_token',
    sellPrice: 7,
  });
  assert.equal(getNpcSellOffer('fish_merchant', 'missing_item'), null);
  assert.equal(findBestNpcSellOffer('missing_item'), null);
}

function run() {
  try {
    testNpcSellOfferAccessors();
    console.log('test-game-data: PASS');
  } finally {
    _resetForTests();
  }
}

run();
