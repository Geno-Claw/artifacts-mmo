#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const bankOps = await import('../src/services/bank-ops.mjs');
const {
  _setApiClientForTests: setBankOpsApi,
  _resetForTests: resetBankOps,
  withdrawGoldFromBank,
} = bankOps;

const BANKS = [
  {
    map_id: 334,
    name: 'City',
    x: 4,
    y: 1,
    access: { conditions: [] },
    interactions: { content: { type: 'bank', code: 'bank' } },
  },
  {
    map_id: 955,
    name: 'Forest',
    x: 7,
    y: 13,
    access: { conditions: [] },
    interactions: { content: { type: 'bank', code: 'bank' } },
  },
];

const state = {
  position: new Map(),     // name -> {x,y}
  inventory: new Map(),    // name -> Map<code, qty>
  moves: [],
  uses: [],
  withdrawGold: [],
  failUseForCode: null,
};

function resetState() {
  state.position = new Map();
  state.inventory = new Map();
  state.moves = [];
  state.uses = [];
  state.withdrawGold = [];
  state.failUseForCode = null;
}

function setPos(name, x, y) {
  state.position.set(name, { x, y });
}

function getPos(name) {
  return state.position.get(name) || { x: 0, y: 0 };
}

function setInventory(name, rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.code) continue;
    const qty = Number(row.quantity) || 0;
    if (qty <= 0) continue;
    map.set(row.code, qty);
  }
  state.inventory.set(name, map);
}

function itemQty(name, code) {
  return state.inventory.get(name)?.get(code) || 0;
}

function consumeItem(name, code, qty) {
  const map = state.inventory.get(name) || new Map();
  const current = map.get(code) || 0;
  const next = Math.max(0, current - qty);
  if (next > 0) map.set(code, next);
  else map.delete(code);
  state.inventory.set(name, map);
}

function isBankTile(x, y) {
  return BANKS.some(bank => bank.x === x && bank.y === y);
}

const fakeApi = {
  async getMaps(params = {}) {
    if (params.content_type === 'bank') return BANKS;
    return [];
  },
  async move(x, y, name) {
    setPos(name, x, y);
    state.moves.push({ name, x, y });
    return { cooldown: { remaining_seconds: 0 } };
  },
  async useItem(code, quantity, name) {
    state.uses.push({ name, code, quantity });
    if (state.failUseForCode === code) {
      const err = new Error(`Injected failure for ${code}`);
      err.code = 496;
      throw err;
    }
    if (itemQty(name, code) < quantity) {
      const err = new Error(`Missing ${code}`);
      err.code = 478;
      throw err;
    }
    consumeItem(name, code, quantity);
    if (code === 'recall_potion') setPos(name, 0, 0);
    if (code === 'forest_bank_potion') setPos(name, 7, 13);
    return { cooldown: { remaining_seconds: 0 } };
  },
  async withdrawGold(quantity, name) {
    const pos = getPos(name);
    if (!isBankTile(pos.x, pos.y)) {
      throw new Error('Bank not found on this map.');
    }
    state.withdrawGold.push({ name, quantity });
    return { cooldown: { remaining_seconds: 0 } };
  },
  async waitForCooldown() {},
};

function makeCtx(name, { x = 0, y = 0, inventory = [], settings = {} } = {}) {
  setPos(name, x, y);
  setInventory(name, inventory);
  return {
    name,
    get() {
      const pos = getPos(name);
      return {
        x: pos.x,
        y: pos.y,
      };
    },
    settings() {
      return settings;
    },
    hasItem(code, qty = 1) {
      return itemQty(name, code) >= qty;
    },
    async refresh() {},
  };
}

async function resetHarness() {
  resetState();
  resetBankOps();
  setBankOpsApi(fakeApi);
}

async function testDirectChosenWhenSavingsLow() {
  await resetHarness();
  const ctx = makeCtx('DirectOnly', {
    x: 3,
    y: 1,
    inventory: [
      { code: 'recall_potion', quantity: 5 },
      { code: 'forest_bank_potion', quantity: 5 },
    ],
    settings: {
      potions: {
        enabled: true,
        bankTravel: { enabled: true, minSavingsSeconds: 10, includeReturnToOrigin: true },
      },
    },
  });

  await withdrawGoldFromBank(ctx, 10);
  assert.equal(state.uses.length, 0, 'direct travel should not consume potion when savings are too small');
  assert.equal(state.moves.length, 1, 'direct travel should move once');
  assert.deepEqual(state.moves[0], { name: 'DirectOnly', x: 4, y: 1 });
}

async function testRecallChosenWhenBest() {
  await resetHarness();
  const ctx = makeCtx('RecallBest', {
    x: -20,
    y: -20,
    inventory: [
      { code: 'recall_potion', quantity: 5 },
      { code: 'forest_bank_potion', quantity: 5 },
    ],
    settings: {
      potions: {
        enabled: true,
        bankTravel: { enabled: true, minSavingsSeconds: 10, includeReturnToOrigin: true },
      },
    },
  });

  await withdrawGoldFromBank(ctx, 10);
  assert.equal(state.uses.length, 1, 'best travel should consume one potion');
  assert.equal(state.uses[0].code, 'recall_potion', 'recall should be selected when best');
  assert.ok(state.moves.some(m => m.x === 4 && m.y === 1), 'should end at a bank tile after recall');
}

async function testForestChosenWhenBest() {
  await resetHarness();
  const ctx = makeCtx('ForestBest', {
    x: 30,
    y: 30,
    inventory: [
      { code: 'recall_potion', quantity: 5 },
      { code: 'forest_bank_potion', quantity: 5 },
    ],
    settings: {
      potions: {
        enabled: true,
        bankTravel: { enabled: true, minSavingsSeconds: 10, includeReturnToOrigin: true },
      },
    },
  });

  await withdrawGoldFromBank(ctx, 10);
  assert.equal(state.uses.length, 1, 'forest case should consume one potion');
  assert.equal(state.uses[0].code, 'forest_bank_potion', 'forest bank potion should be selected when best');
}

async function testFallbackToDirectWhenPotionUseFails() {
  await resetHarness();
  state.failUseForCode = 'recall_potion';

  const ctx = makeCtx('Fallback', {
    x: -20,
    y: -20,
    inventory: [
      { code: 'recall_potion', quantity: 5 },
    ],
    settings: {
      potions: {
        enabled: true,
        bankTravel: { enabled: true, minSavingsSeconds: 10, includeReturnToOrigin: true },
      },
    },
  });

  await withdrawGoldFromBank(ctx, 10);
  assert.equal(state.uses.length, 1, 'should attempt potion before fallback');
  assert.equal(state.uses[0].code, 'recall_potion');
  assert.equal(state.moves.length, 1, 'failed potion should fall back to one direct move');
  assert.deepEqual(state.moves[0], { name: 'Fallback', x: 4, y: 1 });
}

async function testFallbackUsesOriginNearestBank() {
  await resetHarness();
  state.failUseForCode = 'recall_potion';

  const ctx = makeCtx('FallbackNearest', {
    x: -20,
    y: 30,
    inventory: [
      { code: 'recall_potion', quantity: 5 },
    ],
    settings: {
      potions: {
        enabled: true,
        bankTravel: { enabled: true, minSavingsSeconds: 10, includeReturnToOrigin: true },
      },
    },
  });

  await withdrawGoldFromBank(ctx, 10);
  assert.equal(state.uses.length, 1, 'should attempt potion before fallback');
  assert.equal(state.uses[0].code, 'recall_potion');
  assert.equal(state.moves.length, 1, 'failed potion should still perform one direct move');
  assert.deepEqual(state.moves[0], { name: 'FallbackNearest', x: 7, y: 13 }, 'fallback should go to nearest bank from origin');
}

async function run() {
  await testDirectChosenWhenSavingsLow();
  await testRecallChosenWhenBest();
  await testForestChosenWhenBest();
  await testFallbackToDirectWhenPotionUseFails();
  await testFallbackUsesOriginNearestBank();
  resetBankOps();
  console.log('bank travel potion tests passed');
}

run().catch((err) => {
  resetBankOps();
  console.error(err);
  process.exit(1);
});
