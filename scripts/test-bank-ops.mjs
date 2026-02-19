#!/usr/bin/env node
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { BANK } = await import('../src/data/locations.mjs');
const inventoryManager = await import('../src/services/inventory-manager.mjs');
const bankOps = await import('../src/services/bank-ops.mjs');
const orderBoard = await import('../src/services/order-board.mjs');

const {
  _resetForTests: resetInventoryManager,
  _setApiClientForTests: setInventoryApi,
  bankCount,
  getBankItems,
  snapshot,
} = inventoryManager;

const {
  _resetForTests: resetBankOps,
  _setApiClientForTests: setBankOpsApi,
  _setForcedBatchReserveFailuresForTests,
  depositAllInventory,
  depositBankItems,
  depositGoldToBank,
  withdrawBankItems,
  withdrawGoldFromBank,
} = bankOps;

const {
  _resetOrderBoardForTests: resetOrderBoard,
  claimOrder,
  createOrMergeOrder,
  getOrderBoardSnapshot,
  initializeOrderBoard,
} = orderBoard;

const ORDER_BOARD_TEST_PATH = join(tmpdir(), `bank-ops-order-board-${process.pid}.json`);

const state = {
  bank: new Map(),
  bankCalls: 0,
  moveCalls: [],
  withdrawCalls: [],
  depositCalls: [],
  withdrawGoldCalls: [],
  depositGoldCalls: [],
  inventoryByChar: {},
  inventorySlotsByChar: {},
  positionByChar: {},
  goldByChar: {},
  failAlwaysAvailabilityCode: null,
  failAlwaysLocationCode: null,
  failNextGenericCode: null,
};

function ensureChar(name) {
  if (!state.positionByChar[name]) state.positionByChar[name] = { x: 0, y: 0 };
  if (!state.inventorySlotsByChar[name]) state.inventorySlotsByChar[name] = [];
  if (!Number.isFinite(state.inventoryByChar[name])) state.inventoryByChar[name] = 0;
  if (!Number.isFinite(state.goldByChar[name])) state.goldByChar[name] = 0;
}

function setCharPosition(name, x, y) {
  ensureChar(name);
  state.positionByChar[name] = { x, y };
}

function setCharGold(name, gold) {
  ensureChar(name);
  state.goldByChar[name] = Number(gold) || 0;
}

function setCharInventory(name, items = []) {
  ensureChar(name);
  const normalized = [];
  for (const item of items) {
    const code = item?.code;
    const quantity = Number(item?.quantity) || 0;
    if (!code || quantity <= 0) continue;
    normalized.push({ code, quantity });
  }
  state.inventorySlotsByChar[name] = normalized;
  state.inventoryByChar[name] = normalized.reduce((sum, row) => sum + row.quantity, 0);
}

function addInventory(name, code, quantity) {
  ensureChar(name);
  const qty = Number(quantity) || 0;
  if (!code || qty <= 0) return;

  const slots = state.inventorySlotsByChar[name];
  const existing = slots.find(row => row.code === code);
  if (existing) {
    existing.quantity += qty;
  } else {
    slots.push({ code, quantity: qty });
  }
  state.inventoryByChar[name] += qty;
}

function removeInventory(name, code, quantity) {
  ensureChar(name);
  const qty = Number(quantity) || 0;
  if (!code || qty <= 0) return;

  const slots = state.inventorySlotsByChar[name];
  const idx = slots.findIndex(row => row.code === code);
  if (idx < 0) return;

  const current = slots[idx].quantity;
  const used = Math.min(current, qty);
  const next = current - used;
  if (next > 0) {
    slots[idx].quantity = next;
  } else {
    slots.splice(idx, 1);
  }
  state.inventoryByChar[name] = Math.max(0, state.inventoryByChar[name] - used);
}

function isAtBank(name) {
  const pos = state.positionByChar[name] || { x: 0, y: 0 };
  return pos.x === BANK.x && pos.y === BANK.y;
}

function setBank(entries) {
  state.bank = new Map(entries);
}

function resetState() {
  state.bank = new Map();
  state.bankCalls = 0;
  state.moveCalls = [];
  state.withdrawCalls = [];
  state.depositCalls = [];
  state.withdrawGoldCalls = [];
  state.depositGoldCalls = [];
  state.inventoryByChar = {};
  state.inventorySlotsByChar = {};
  state.positionByChar = {};
  state.goldByChar = {};
  state.failAlwaysAvailabilityCode = null;
  state.failAlwaysLocationCode = null;
  state.failNextGenericCode = null;
}

const fakeApi = {
  async getMyCharacters() {
    return [];
  },
  async getMaps(params = {}) {
    if (params.content_type === 'bank') {
      return [{
        map_id: 334,
        name: 'City',
        x: BANK.x,
        y: BANK.y,
        access: { conditions: [] },
        interactions: { content: { type: 'bank', code: 'bank' } },
      }];
    }
    return [];
  },
  async getBankItems({ page }) {
    state.bankCalls += 1;
    if (page !== 1) return [];
    return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
  },
  async move(x, y, name) {
    setCharPosition(name, x, y);
    state.moveCalls.push({ x, y, name });
    return { cooldown: { remaining_seconds: 0 } };
  },
  async withdrawBank(items, name) {
    if (!isAtBank(name)) {
      throw new Error('Bank not found on this map.');
    }

    for (const item of items) {
      const code = item?.code;
      const quantity = Number(item?.quantity) || 0;
      if (!code || quantity <= 0) continue;

      if (state.failAlwaysLocationCode === code) {
        throw new Error('Bank not found on this map.');
      }
      if (state.failAlwaysAvailabilityCode === code) {
        throw new Error(`Not enough quantity for ${code}`);
      }
      if (state.failNextGenericCode === code) {
        state.failNextGenericCode = null;
        throw new Error(`Injected generic failure for ${code}`);
      }

      const current = state.bank.get(code) || 0;
      if (current < quantity) {
        throw new Error(`Not enough quantity for ${code}`);
      }

      const next = current - quantity;
      if (next > 0) state.bank.set(code, next);
      else state.bank.delete(code);

      state.withdrawCalls.push({ code, quantity, name });
      addInventory(name, code, quantity);
    }

    return { cooldown: { remaining_seconds: 0 } };
  },
  async depositBank(items, name) {
    if (!isAtBank(name)) {
      throw new Error('Bank not found on this map.');
    }

    for (const item of items) {
      const code = item?.code;
      const quantity = Number(item?.quantity) || 0;
      if (!code || quantity <= 0) continue;

      state.bank.set(code, (state.bank.get(code) || 0) + quantity);
      state.depositCalls.push({ code, quantity, name });
      removeInventory(name, code, quantity);
    }

    return { cooldown: { remaining_seconds: 0 } };
  },
  async withdrawGold(quantity, name) {
    if (!isAtBank(name)) {
      throw new Error('Bank not found on this map.');
    }
    const qty = Number(quantity) || 0;
    if (qty <= 0) return { cooldown: { remaining_seconds: 0 } };
    state.withdrawGoldCalls.push({ quantity: qty, name });
    state.goldByChar[name] = (state.goldByChar[name] || 0) + qty;
    return { cooldown: { remaining_seconds: 0 } };
  },
  async depositGold(quantity, name) {
    if (!isAtBank(name)) {
      throw new Error('Bank not found on this map.');
    }
    const qty = Number(quantity) || 0;
    if (qty <= 0) return { cooldown: { remaining_seconds: 0 } };

    const current = state.goldByChar[name] || 0;
    if (current < qty) {
      throw new Error(`Not enough gold to deposit ${qty}`);
    }

    state.depositGoldCalls.push({ quantity: qty, name });
    state.goldByChar[name] = current - qty;
    return { cooldown: { remaining_seconds: 0 } };
  },
  async waitForCooldown() {},
};

function makeCtx(name = 'Tester', opts = {}) {
  const capacity = Number(opts.capacity) || 30;
  const startX = Number.isFinite(opts.startX) ? opts.startX : 0;
  const startY = Number.isFinite(opts.startY) ? opts.startY : 0;
  setCharPosition(name, startX, startY);
  setCharInventory(name, opts.inventory || []);
  setCharGold(name, opts.gold || 0);

  return {
    name,
    inventoryCapacity() {
      return capacity;
    },
    inventoryCount() {
      return state.inventoryByChar[name] || 0;
    },
    isAt(x, y) {
      const pos = state.positionByChar[name] || { x: 0, y: 0 };
      return pos.x === x && pos.y === y;
    },
    get() {
      const pos = state.positionByChar[name] || { x: 0, y: 0 };
      return {
        x: pos.x,
        y: pos.y,
        gold: state.goldByChar[name] || 0,
        inventory: state.inventorySlotsByChar[name] || [],
      };
    },
    async refresh() {},
  };
}

function reservationCount() {
  return Object.keys(snapshot().reservations).length;
}

async function resetHarness() {
  resetState();
  resetInventoryManager();
  resetBankOps();
  resetOrderBoard();
  setInventoryApi(fakeApi);
  setBankOpsApi(fakeApi);
  _setForcedBatchReserveFailuresForTests(0);
  const isolatedPath = `${ORDER_BOARD_TEST_PATH}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await initializeOrderBoard({ path: isolatedPath });
}

async function run() {
  // 1) Off-bank withdraw auto-moves to bank.
  await resetHarness();
  setBank([
    ['wooden_shield', 5],
    ['copper_ring', 4],
  ]);
  await getBankItems(true);
  const ctx1 = makeCtx('A', { startX: 0, startY: 0 });
  const ok = await withdrawBankItems(ctx1, [
    { code: 'wooden_shield', quantity: 3 },
    { code: 'copper_ring', quantity: 2 },
  ], { reason: 'test batch success' });
  assert.deepEqual(ok.withdrawn, [
    { code: 'wooden_shield', quantity: 3 },
    { code: 'copper_ring', quantity: 2 },
  ], 'batch withdraw should succeed');
  assert.equal(state.moveCalls.length, 1, 'withdraw should auto-move to bank once');
  assert.deepEqual(state.moveCalls[0], { x: BANK.x, y: BANK.y, name: 'A' }, 'auto-move target must be bank');
  assert.equal(state.withdrawCalls[0]?.code, 'wooden_shield', 'withdraw order should follow request order');
  assert.equal(state.withdrawCalls[1]?.code, 'copper_ring', 'withdraw order should follow request order');
  assert.equal(reservationCount(), 0, 'reservations released after success');

  // 2) Batch reserve fail once -> refresh -> retry success.
  await resetHarness();
  setBank([['iron_ore', 3]]);
  await getBankItems(true);
  _setForcedBatchReserveFailuresForTests(1);
  const ctx2 = makeCtx('B', { startX: BANK.x, startY: BANK.y });
  const callsBeforeRetry = state.bankCalls;
  const retried = await withdrawBankItems(ctx2, [{ code: 'iron_ore', quantity: 2 }], {
    reason: 'test retry path',
  });
  assert.deepEqual(retried.withdrawn, [{ code: 'iron_ore', quantity: 2 }], 'retry should recover after forced first failure');
  assert.ok(state.bankCalls > callsBeforeRetry, 'retry path should force-refresh bank');
  assert.equal(reservationCount(), 0, 'reservations released after retry success');

  // 3) Batch reserve fail twice -> per-item fallback still withdraws.
  await resetHarness();
  setBank([
    ['copper_ore', 2],
    ['tin_ore', 1],
  ]);
  await getBankItems(true);
  _setForcedBatchReserveFailuresForTests(2);
  const ctx3 = makeCtx('C', { startX: BANK.x, startY: BANK.y });
  const fallback = await withdrawBankItems(ctx3, [
    { code: 'copper_ore', quantity: 2 },
    { code: 'tin_ore', quantity: 1 },
  ], { reason: 'test fallback path' });
  assert.deepEqual(fallback.withdrawn, [
    { code: 'copper_ore', quantity: 2 },
    { code: 'tin_ore', quantity: 1 },
  ], 'fallback path should still withdraw per-item');
  assert.equal(reservationCount(), 0, 'reservations released after fallback path');

  // 4) Partial fill with limited availability.
  await resetHarness();
  setBank([['feather', 3]]);
  await getBankItems(true);
  const ctx4 = makeCtx('D', { startX: BANK.x, startY: BANK.y });
  const partial = await withdrawBankItems(ctx4, [{ code: 'feather', quantity: 5 }], {
    reason: 'test partial',
    mode: 'partial',
  });
  assert.deepEqual(partial.withdrawn, [{ code: 'feather', quantity: 3 }], 'partial mode should withdraw available quantity');
  assert.ok(
    partial.skipped.some(s => s.code === 'feather' && s.reason.includes('partial fill')),
    'partial fill should be recorded in skipped results',
  );

  // 5) Reservation release on API throw.
  await resetHarness();
  setBank([['sapphire_stone', 2]]);
  await getBankItems(true);
  state.failNextGenericCode = 'sapphire_stone';
  const ctx5 = makeCtx('E', { startX: BANK.x, startY: BANK.y });
  const thrown = await withdrawBankItems(ctx5, [{ code: 'sapphire_stone', quantity: 1 }], {
    reason: 'test generic throw',
    retryStaleOnce: false,
  });
  assert.equal(thrown.withdrawn.length, 0, 'generic throw should not report successful withdraw');
  assert.equal(thrown.failed.length, 1, 'generic throw should report a failed row');
  assert.equal(reservationCount(), 0, 'reservations should be released after throw');

  // 6) Availability failure invalidates bank cache.
  await resetHarness();
  setBank([['ash_wood', 1]]);
  await getBankItems(true);
  state.failAlwaysAvailabilityCode = 'ash_wood';
  const ctx6 = makeCtx('F', { startX: BANK.x, startY: BANK.y });
  await withdrawBankItems(ctx6, [{ code: 'ash_wood', quantity: 1 }], {
    reason: 'test invalidation',
    retryStaleOnce: false,
  });
  setBank([['ash_wood', 9]]);
  const callsBeforeInvalidateCheck = state.bankCalls;
  await getBankItems();
  assert.ok(state.bankCalls > callsBeforeInvalidateCheck, 'availability failure should invalidate cache and trigger refetch');
  assert.equal(bankCount('ash_wood'), 9, 'invalidated refetch should load latest server quantity');

  // 7) Off-bank item deposit auto-moves to bank.
  await resetHarness();
  setBank([['birch_wood', 1]]);
  await getBankItems(true);
  const ctx7 = makeCtx('G', {
    startX: 0,
    startY: 0,
    inventory: [{ code: 'birch_wood', quantity: 2 }],
  });
  await depositBankItems(ctx7, [{ code: 'birch_wood', quantity: 2 }], {
    reason: 'test deposit items',
  });
  assert.equal(state.moveCalls.length, 1, 'item deposit should auto-move to bank once');
  assert.deepEqual(state.moveCalls[0], { x: BANK.x, y: BANK.y, name: 'G' }, 'item deposit move target must be bank');
  assert.equal(bankCount('birch_wood'), 3, 'item deposit should update bank delta');

  // 8) Deposits should advance claimed order-board progress.
  await resetHarness();
  setBank([]);
  await getBankItems(true);
  const order = createOrMergeOrder({
    requesterName: 'CrafterA',
    recipeCode: 'oak_spear',
    itemCode: 'birch_wood',
    sourceType: 'gather',
    sourceCode: 'birch_tree',
    gatherSkill: 'woodcutting',
    sourceLevel: 5,
    quantity: 2,
  });
  assert.ok(order, 'expected test order to be created');
  const claimed = claimOrder(order.id, { charName: 'OrderWorker', leaseMs: 5_000 });
  assert.ok(claimed, 'expected order to be claimed by worker');

  const ctxOrder = makeCtx('OrderWorker', {
    startX: BANK.x,
    startY: BANK.y,
    inventory: [{ code: 'birch_wood', quantity: 2 }],
  });
  await depositBankItems(ctxOrder, [{ code: 'birch_wood', quantity: 2 }], {
    reason: 'test order-board deposit hook',
  });

  const orderSnapshot = getOrderBoardSnapshot();
  const updatedOrder = orderSnapshot.orders.find(row => row.id === order.id);
  assert.ok(updatedOrder, 'order should remain in board snapshot');
  assert.equal(updatedOrder.remainingQty, 0, 'deposit hook should reduce remaining qty');
  assert.equal(updatedOrder.status, 'fulfilled', 'deposit hook should fulfill fully deposited order');

  // 9) depositAllInventory uses centralized deposit path.
  await resetHarness();
  setBank([]);
  await getBankItems(true);
  const ctx8 = makeCtx('H', {
    startX: 0,
    startY: 0,
    inventory: [
      { code: 'copper_ore', quantity: 3 },
      { code: 'tin_ore', quantity: 1 },
    ],
  });
  await depositAllInventory(ctx8, { reason: 'test deposit all' });
  assert.equal(state.moveCalls.length, 1, 'depositAllInventory should auto-move to bank once');
  assert.equal(bankCount('copper_ore'), 3, 'depositAllInventory should deposit copper_ore');
  assert.equal(bankCount('tin_ore'), 1, 'depositAllInventory should deposit tin_ore');

  // 9b) depositAllInventory should respect keepByCode and keep claimed inventory on character.
  await resetHarness();
  setBank([]);
  await getBankItems(true);
  const ctx8b = makeCtx('H2', {
    startX: BANK.x,
    startY: BANK.y,
    inventory: [
      { code: 'iron_sword', quantity: 1 },
      { code: 'copper_ore', quantity: 4 },
    ],
  });
  await depositAllInventory(ctx8b, {
    reason: 'test deposit all with keep',
    keepByCode: { iron_sword: 1, copper_ore: 1 },
  });
  assert.equal(bankCount('iron_sword'), 0, 'kept owned gear should remain on character');
  assert.equal(bankCount('copper_ore'), 3, 'deposit should keep configured carry quantity');
  assert.equal(state.inventorySlotsByChar.H2.find(row => row.code === 'iron_sword')?.quantity || 0, 1, 'kept gear should stay in inventory');
  assert.equal(state.inventorySlotsByChar.H2.find(row => row.code === 'copper_ore')?.quantity || 0, 1, 'kept quantity should remain in inventory');

  // 10) Off-bank gold withdraw/deposit auto-moves to bank.
  await resetHarness();
  setBank([]);
  await getBankItems(true);
  const ctx9 = makeCtx('I', { startX: 0, startY: 0, gold: 20 });
  await withdrawGoldFromBank(ctx9, 30, { reason: 'test withdraw gold' });
  assert.equal(state.moveCalls.length, 1, 'withdrawGoldFromBank should auto-move to bank once');
  assert.equal(state.withdrawGoldCalls.length, 1, 'withdrawGoldFromBank should call API once');
  await depositGoldToBank(ctx9, 10, { reason: 'test deposit gold' });
  assert.equal(state.moveCalls.length, 1, 'depositGoldToBank should not move again when already at bank');
  assert.equal(state.depositGoldCalls.length, 1, 'depositGoldToBank should call API once');

  // 11) Location errors are not treated as stale availability (no retry + no invalidation).
  await resetHarness();
  setBank([['spruce_wood', 4]]);
  await getBankItems(true);
  state.failAlwaysLocationCode = 'spruce_wood';
  const ctx10 = makeCtx('J', { startX: BANK.x, startY: BANK.y });
  const callsBeforeLocationFailure = state.bankCalls;
  const locationFailure = await withdrawBankItems(ctx10, [{ code: 'spruce_wood', quantity: 1 }], {
    reason: 'test bank location classification',
    retryStaleOnce: true,
  });
  assert.equal(locationFailure.withdrawn.length, 0, 'location failure should not report withdraw success');
  assert.equal(locationFailure.failed.length, 1, 'location failure should report failed row');
  assert.equal(state.withdrawCalls.length, 0, 'location failure should not apply successful withdraw calls');
  assert.equal(state.bankCalls, callsBeforeLocationFailure, 'location failure should not force-refresh bank for retry');

  setBank([['spruce_wood', 9]]);
  const callsBeforePostLocationGet = state.bankCalls;
  await getBankItems();
  assert.equal(state.bankCalls, callsBeforePostLocationGet, 'location failure should not invalidate bank cache');

  console.log('bank-ops tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
