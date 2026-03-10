#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  _resetForTests,
  _setCachesForTests,
  findBestNpcBuyOffer,
  canSellToNpc,
  findBestNpcSellOffer,
  getNpcBuyOffer,
  getNpcBuyPrice,
  getNpcSellOffer,
  getNpcSellPrice,
} from '../src/services/game-data.mjs';

function testNpcBuyOfferAccessors() {
  _resetForTests();
  _setCachesForTests({
    npcBuyOffers: [
      ['rune_vendor', [
        ['healing_rune', { code: 'healing_rune', currency: 'gold', buyPrice: 10000 }],
        ['greater_healing_rune', { code: 'greater_healing_rune', currency: 'sand_token', buyPrice: 30 }],
      ]],
      ['capital_vendor', [
        ['healing_rune', { code: 'healing_rune', currency: 'gold', buyPrice: 9200 }],
      ]],
      ['trader', [
        ['healing_rune', { code: 'healing_rune', currency: 'shell_token', buyPrice: 15 }],
        ['broken_offer', { code: 'broken_offer', currency: 'gold', buyPrice: 0 }],
      ]],
    ],
  });

  assert.deepEqual(getNpcBuyOffer('rune_vendor', 'healing_rune'), {
    code: 'healing_rune',
    currency: 'gold',
    buyPrice: 10000,
  });
  assert.equal(getNpcBuyPrice('capital_vendor', 'healing_rune'), 9200);
  assert.deepEqual(findBestNpcBuyOffer('healing_rune'), {
    npcCode: 'capital_vendor',
    currency: 'gold',
    buyPrice: 9200,
  });
  assert.equal(findBestNpcBuyOffer('greater_healing_rune'), null, 'non-gold NPC buy offers should be ignored for GE pricing');
  assert.equal(findBestNpcBuyOffer('missing_item'), null);
}

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
    testNpcBuyOfferAccessors();
    testNpcSellOfferAccessors();
    console.log('test-game-data: PASS');
  } finally {
    _resetForTests();
  }
}

run();
