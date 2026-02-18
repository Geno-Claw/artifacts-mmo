#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const inventoryManager = await import('../src/services/inventory-manager.mjs');
const bankOps = await import('../src/services/bank-ops.mjs');

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
  withdrawBankItems,
} = bankOps;

const state = {
  bank: new Map(),
  bankCalls: 0,
  withdrawCalls: [],
  inventoryByChar: {},
  failAlwaysAvailabilityCode: null,
  failNextGenericCode: null,
};

function setBank(entries) {
  state.bank = new Map(entries);
}

function resetState() {
  state.bank = new Map();
  state.bankCalls = 0;
  state.withdrawCalls = [];
  state.inventoryByChar = {};
  state.failAlwaysAvailabilityCode = null;
  state.failNextGenericCode = null;
}

const fakeApi = {
  async getMyCharacters() {
    return [];
  },
  async getBankItems({ page }) {
    state.bankCalls += 1;
    if (page !== 1) return [];
    return [...state.bank.entries()].map(([code, quantity]) => ({ code, quantity }));
  },
  async withdrawBank(items, name) {
    for (const item of items) {
      const code = item?.code;
      const quantity = Number(item?.quantity) || 0;
      if (!code || quantity <= 0) continue;

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
      state.inventoryByChar[name] = (state.inventoryByChar[name] || 0) + quantity;
    }

    return { cooldown: { remaining_seconds: 0 } };
  },
  async waitForCooldown() {},
};

function makeCtx(name = 'Tester', capacity = 30) {
  return {
    name,
    inventoryCapacity() {
      return capacity;
    },
    inventoryCount() {
      return state.inventoryByChar[name] || 0;
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
  setInventoryApi(fakeApi);
  setBankOpsApi(fakeApi);
  _setForcedBatchReserveFailuresForTests(0);
}

async function run() {
  // 1) Batch reserve success and order.
  await resetHarness();
  setBank([
    ['wooden_shield', 5],
    ['copper_ring', 4],
  ]);
  await getBankItems(true);
  const ctx1 = makeCtx('A');
  const ok = await withdrawBankItems(ctx1, [
    { code: 'wooden_shield', quantity: 3 },
    { code: 'copper_ring', quantity: 2 },
  ], { reason: 'test batch success' });
  assert.deepEqual(ok.withdrawn, [
    { code: 'wooden_shield', quantity: 3 },
    { code: 'copper_ring', quantity: 2 },
  ], 'batch withdraw should succeed');
  assert.equal(state.withdrawCalls[0]?.code, 'wooden_shield', 'withdraw order should follow request order');
  assert.equal(state.withdrawCalls[1]?.code, 'copper_ring', 'withdraw order should follow request order');
  assert.equal(reservationCount(), 0, 'reservations released after success');

  // 2) Batch reserve fail once -> refresh -> retry success.
  await resetHarness();
  setBank([['iron_ore', 3]]);
  await getBankItems(true);
  _setForcedBatchReserveFailuresForTests(1);
  const ctx2 = makeCtx('B');
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
  const ctx3 = makeCtx('C');
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
  const ctx4 = makeCtx('D');
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
  const ctx5 = makeCtx('E');
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
  const ctx6 = makeCtx('F');
  await withdrawBankItems(ctx6, [{ code: 'ash_wood', quantity: 1 }], {
    reason: 'test invalidation',
    retryStaleOnce: false,
  });
  setBank([['ash_wood', 9]]);
  const callsBeforeInvalidateCheck = state.bankCalls;
  await getBankItems();
  assert.ok(state.bankCalls > callsBeforeInvalidateCheck, 'availability failure should invalidate cache and trigger refetch');
  assert.equal(bankCount('ash_wood'), 9, 'invalidated refetch should load latest server quantity');

  console.log('bank-ops tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
