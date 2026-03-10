#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  _resetForTests as resetGameDataForTests,
  _setCachesForTests as setGameDataCachesForTests,
} from '../src/services/game-data.mjs';
import {
  _resetForTests as resetNpcSellerForTests,
  _setDepsForTests as setNpcSellerDepsForTests,
  analyzeNpcSellCandidates,
  executeNpcSellFlow,
} from '../src/services/npc-seller.mjs';
import { loadNpcSellList } from '../src/services/npc-sell-config.mjs';

function makeCtx({ name = 'Seller', inventoryMaxItems = 100 } = {}) {
  const inventory = new Map();
  let position = { x: 0, y: 0 };

  return {
    name,
    _inventory: inventory,
    _addItem(code, quantity) {
      inventory.set(code, (inventory.get(code) || 0) + quantity);
    },
    _removeItem(code, quantity) {
      const next = Math.max(0, (inventory.get(code) || 0) - quantity);
      if (next > 0) inventory.set(code, next);
      else inventory.delete(code);
    },
    get() {
      return {
        x: position.x,
        y: position.y,
        inventory_max_items: inventoryMaxItems,
      };
    },
    applyActionResult() {},
    inventoryCapacity() {
      return inventoryMaxItems;
    },
    inventoryCount() {
      let total = 0;
      for (const quantity of inventory.values()) total += quantity;
      return total;
    },
    itemCount(code) {
      return inventory.get(code) || 0;
    },
    isAt(x, y) {
      return position.x === x && position.y === y;
    },
    _moveTo(x, y) {
      position = { x, y };
    },
  };
}

async function testAnalyzeExplicitOverride() {
  resetGameDataForTests();
  resetNpcSellerForTests();
  loadNpcSellList({
    npcSellList: {
      nomadic_merchant: [{ code: 'old_boots', keepInBank: 1 }],
    },
  });
  setGameDataCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 500 }]]],
    ],
  });
  setNpcSellerDepsForTests({
    getPreferredNpcTileFn: async () => ({ x: 4, y: 7 }),
    getActiveNpcEventsFn: () => [],
    getNpcEventCodesFn: () => [],
    analyzeSurplusEquipmentCandidatesFn: () => [],
  });

  const rows = await analyzeNpcSellCandidates(makeCtx(), new Map([['old_boots', 5]]), { sellRules: null });
  assert.deepEqual(rows, [{
    code: 'old_boots',
    quantity: 4,
    npcCode: 'nomadic_merchant',
    sellPrice: 500,
    currency: 'gold',
    reason: 'npc-sell override (keeping 1)',
    npcIsEvent: false,
    npcAvailable: true,
    map: { x: 4, y: 7 },
  }]);
}

async function testAnalyzeAlwaysSellAndBestOffer() {
  resetGameDataForTests();
  resetNpcSellerForTests();
  loadNpcSellList({});
  setGameDataCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [['bone_ring', { code: 'bone_ring', currency: 'gold', sellPrice: 300 }]]],
      ['fish_merchant', [['bone_ring', { code: 'bone_ring', currency: 'gold', sellPrice: 325 }]]],
    ],
  });
  setNpcSellerDepsForTests({
    getPreferredNpcTileFn: async (npcCode) => (npcCode === 'fish_merchant' ? { x: 9, y: 9 } : { x: 4, y: 7 }),
    getActiveNpcEventsFn: () => [],
    getNpcEventCodesFn: () => [],
    analyzeSurplusEquipmentCandidatesFn: () => [],
  });

  const rows = await analyzeNpcSellCandidates(makeCtx(), new Map([['bone_ring', 6]]), {
    sellRules: {
      alwaysSell: [{ code: 'bone_ring', keepInBank: 2 }],
      neverSell: [],
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].npcCode, 'fish_merchant');
  assert.equal(rows[0].quantity, 4);
  assert.equal(rows[0].sellPrice, 325);
}

async function testAnalyzeDuplicateEventOnlyUnavailable() {
  resetGameDataForTests();
  resetNpcSellerForTests();
  loadNpcSellList({});
  setGameDataCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [['forest_ring', { code: 'forest_ring', currency: 'gold', sellPrice: 250 }]]],
    ],
  });
  setNpcSellerDepsForTests({
    getPreferredNpcTileFn: async () => null,
    getActiveNpcEventsFn: () => [],
    getNpcEventCodesFn: () => ['nomadic_merchant'],
    analyzeSurplusEquipmentCandidatesFn: () => [
      { code: 'forest_ring', quantity: 2, reason: 'duplicate surplus' },
    ],
  });

  const rows = await analyzeNpcSellCandidates(makeCtx(), new Map([['forest_ring', 2]]), {
    sellRules: {
      alwaysSell: [],
      neverSell: [],
      sellDuplicateEquipment: true,
    },
  });

  assert.deepEqual(rows, [{
    code: 'forest_ring',
    quantity: 2,
    npcCode: 'nomadic_merchant',
    sellPrice: 250,
    currency: 'gold',
    reason: 'duplicate surplus',
    npcIsEvent: true,
    npcAvailable: false,
    map: null,
  }]);
}

async function testExecuteNpcSellFlowBatchesAndSells() {
  resetGameDataForTests();
  resetNpcSellerForTests();
  loadNpcSellList({
    npcSellList: {
      nomadic_merchant: [{ code: 'old_boots', keepInBank: 0 }],
    },
  });
  setGameDataCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 500 }]]],
    ],
  });

  const ctx = makeCtx({ inventoryMaxItems: 100 });
  const sells = [];
  const moves = [];

  setNpcSellerDepsForTests({
    getBankItemsFn: async () => new Map([['old_boots', 120]]),
    getPreferredNpcTileFn: async () => ({ x: 4, y: 7 }),
    getActiveNpcEventsFn: () => [],
    getNpcEventCodesFn: () => [],
    analyzeSurplusEquipmentCandidatesFn: () => [],
    withdrawBankItemsFn: async (localCtx, requests) => {
      for (const req of requests) {
        localCtx._addItem(req.code, req.quantity);
      }
      return {
        withdrawn: requests.map(req => ({ ...req })),
        skipped: [],
        failed: [],
      };
    },
    moveToFn: async (localCtx, x, y) => {
      moves.push({ x, y });
      localCtx._moveTo(x, y);
    },
    npcSellFn: async (code, quantity) => {
      sells.push({ code, quantity });
      ctx._removeItem(code, quantity);
      return {};
    },
    waitForCooldownFn: async () => {},
  });

  const sold = await executeNpcSellFlow(ctx, { sellRules: null });
  assert.equal(sold, 120);
  assert.deepEqual(sells, [
    { code: 'old_boots', quantity: 100 },
    { code: 'old_boots', quantity: 20 },
  ]);
  assert.deepEqual(moves, [{ x: 4, y: 7 }]);
}

async function run() {
  try {
    await testAnalyzeExplicitOverride();
    await testAnalyzeAlwaysSellAndBestOffer();
    await testAnalyzeDuplicateEventOnlyUnavailable();
    await testExecuteNpcSellFlowBatchesAndSells();
    console.log('test-npc-seller: PASS');
  } finally {
    loadNpcSellList({});
    resetGameDataForTests();
    resetNpcSellerForTests();
  }
}

run().catch((err) => {
  loadNpcSellList({});
  resetGameDataForTests();
  resetNpcSellerForTests();
  console.error(err);
  process.exit(1);
});
