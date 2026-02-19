#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const manager = await import('../src/services/inventory-manager.mjs');
const {
  _resetForTests,
  _setApiClientForTests,
  availableBankCount,
  applyBankDelta,
  bankCount,
  cleanupExpiredReservations,
  equippedCount,
  getBankItems,
  getCharacterLevelsSnapshot,
  globalCount,
  initialize,
  invalidateBank,
  inventoryCount,
  release,
  releaseAllForChar,
  reserve,
  reserveMany,
  updateCharacter,
} = manager;

function makeChar(name, { inventory = [], slots = {} } = {}) {
  return {
    name,
    inventory,
    ...slots,
  };
}

const state = {
  pages: [
    [
      { code: 'wooden_shield', quantity: 8 },
      { code: 'copper_ring', quantity: 2 },
    ],
    [],
  ],
  calls: 0,
};

const fakeApi = {
  async getMyCharacters() {
    return [
      makeChar('A', {
        inventory: [{ code: 'wooden_shield', quantity: 1 }, { code: 'copper_ring', quantity: 1 }],
        slots: { shield_slot: 'wooden_shield', ring1_slot: 'copper_ring' },
      }),
      makeChar('B', {
        inventory: [{ code: 'wooden_shield', quantity: 2 }],
        slots: { shield_slot: 'wooden_shield', ring1_slot: 'copper_ring' },
      }),
    ];
  },
  async getBankItems({ page }) {
    state.calls++;
    return state.pages[page - 1] || [];
  },
};

async function run() {
  _resetForTests();
  _setApiClientForTests(fakeApi);

  await initialize();

  assert.equal(bankCount('wooden_shield'), 8, 'bank shield count from startup');
  assert.equal(inventoryCount('wooden_shield'), 3, 'inventory shield total from startup');
  assert.equal(equippedCount('wooden_shield'), 2, 'equipped shield total from startup');
  assert.equal(globalCount('wooden_shield'), 13, 'global shield total from startup');
  assert.deepEqual(
    getCharacterLevelsSnapshot(),
    {},
    'unknown levels should not be tracked',
  );

  // Reservation accounting: available should exclude reservations from other chars.
  const r1 = reserve('wooden_shield', 2, 'A', 200);
  assert.ok(r1, 'single reservation created');
  assert.equal(availableBankCount('wooden_shield'), 6, 'global available excludes reservation');
  assert.equal(availableBankCount('wooden_shield', { includeChar: 'A' }), 8, 'includeChar ignores own reservations');
  const r2 = reserve('wooden_shield', 7, 'B', 200);
  assert.equal(r2, null, 'reservation rejected when insufficient');
  release(r1);
  assert.equal(availableBankCount('wooden_shield'), 8, 'release restores availability');

  // Atomic multi-reserve.
  const batchOk = reserveMany(
    [{ code: 'wooden_shield', qty: 3 }, { code: 'copper_ring', qty: 1 }],
    'A',
    200,
  );
  assert.equal(batchOk.ok, true, 'reserveMany succeeds when all items available');
  assert.equal(batchOk.reservations.length, 2, 'reserveMany returns one reservation per code');

  const batchFail = reserveMany(
    [{ code: 'wooden_shield', qty: 100 }, { code: 'copper_ring', qty: 1 }],
    'B',
    200,
  );
  assert.equal(batchFail.ok, false, 'reserveMany fails atomically when one code is short');
  assert.equal(batchFail.reservations.length, 0, 'failed reserveMany creates no reservations');

  releaseAllForChar('A');
  assert.equal(availableBankCount('wooden_shield'), 8, 'bulk release clears reservations');
  assert.equal(availableBankCount('copper_ring'), 2, 'bulk release clears all reserved codes');

  // Reservation expiry cleanup.
  const expiring = reserve('copper_ring', 1, 'A', 10);
  assert.ok(expiring, 'expiring reservation created');
  assert.equal(availableBankCount('copper_ring'), 1, 'availability reduced before expiry');
  await new Promise(r => setTimeout(r, 25));
  const removed = cleanupExpiredReservations();
  assert.ok(removed >= 1, 'expired reservation removed');
  assert.equal(availableBankCount('copper_ring'), 2, 'availability restored after expiry');

  // Character map rebuild should replace old values, not merge.
  updateCharacter('A', makeChar('A', {
    inventory: [{ code: 'wooden_shield', quantity: 4 }],
    slots: { shield_slot: null, ring1_slot: null, ring2_slot: 'copper_ring', level: 12 },
  }));
  assert.equal(inventoryCount('wooden_shield'), 6, 'inventory rebuild replaced char A data');
  assert.equal(equippedCount('wooden_shield'), 1, 'equipment rebuild replaced char A slots');
  assert.equal(getCharacterLevelsSnapshot().A, 12, 'character level snapshot should refresh with updateCharacter');

  // Bank deltas should update immediately and clamp at zero.
  applyBankDelta([{ code: 'wooden_shield', quantity: 2 }], 'withdraw', { reason: 'test withdraw' });
  assert.equal(bankCount('wooden_shield'), 6, 'withdraw delta applied');
  applyBankDelta([{ code: 'wooden_shield', quantity: 999 }], 'withdraw', { reason: 'test clamp' });
  assert.equal(bankCount('wooden_shield'), 0, 'withdraw delta clamped at zero');
  applyBankDelta([{ code: 'wooden_shield', quantity: 5 }], 'deposit', { reason: 'test deposit' });
  assert.equal(bankCount('wooden_shield'), 5, 'deposit delta applied');

  // Invalidating should force a refetch on next read.
  const callsBeforeInvalidate = state.calls;
  state.pages = [
    [
      { code: 'wooden_shield', quantity: 4 },
      { code: 'steel_helmet', quantity: 3 },
    ],
    [],
  ];
  invalidateBank('test invalidation');
  await getBankItems();
  assert.ok(state.calls > callsBeforeInvalidate, 'invalidate forced fetch');
  assert.equal(bankCount('wooden_shield'), 4, 'refetch replaced bank map (shield)');
  assert.equal(bankCount('steel_helmet'), 3, 'refetch replaced bank map (new item)');

  // In-flight fetch guard: concurrent forced refreshes should share one fetch.
  const callsBeforeConcurrent = state.calls;
  state.pages = [
    [
      { code: 'wooden_shield', quantity: 7 },
    ],
    [],
  ];
  await Promise.all([getBankItems(true), getBankItems(true)]);
  const callDelta = state.calls - callsBeforeConcurrent;
  assert.equal(callDelta, 1, 'concurrent fetches reused in-flight promise');
  assert.equal(bankCount('wooden_shield'), 7, 'concurrent refresh produced expected bank state');

  _resetForTests();
  console.log('inventory-manager tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
