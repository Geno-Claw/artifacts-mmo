#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const {
  DepositBankRoutine,
  _resetDepsForTests: resetDepositBankDeps,
  _setDepsForTests: setDepositBankDeps,
} = await import('../src/routines/deposit-bank.mjs');

function log(label) {
  console.log(`  PASS  ${label}`);
}

function cloneRows(rows = []) {
  return rows.map(row => ({ ...row }));
}

function makePendingEntry(id, items = [], extra = {}) {
  return {
    id,
    source: 'achievement',
    description: id,
    created_at: '2026-03-03T12:00:00Z',
    gold: 0,
    items: cloneRows(items),
    ...extra,
  };
}

function makeCtx({
  name = 'Tester',
  inventory = [],
  inventoryMaxItems = 20,
  maxSlots = 5,
  gold = 0,
} = {}) {
  let character = {
    name,
    inventory: cloneRows(inventory),
    inventory_max_items: inventoryMaxItems,
    gold,
    weapon_slot: '',
  };

  return {
    name,
    get() {
      return character;
    },
    applyActionResult(result) {
      if (result?.character && typeof result.character === 'object') {
        character = {
          ...character,
          ...result.character,
          inventory: cloneRows(result.character.inventory || character.inventory || []),
        };
      }
    },
    inventoryCapacity() {
      return Number(character.inventory_max_items) || 0;
    },
    inventoryCount() {
      return (character.inventory || []).reduce((sum, row) => sum + (Number(row?.quantity) || 0), 0);
    },
    inventoryUsedSlots() {
      return (character.inventory || []).filter(row => row?.code && Number(row.quantity) > 0).length;
    },
    inventoryEmptySlots() {
      return Math.max(0, maxSlots - this.inventoryUsedSlots());
    },
    inventoryFull() {
      return this.inventoryEmptySlots() <= 0 || this.inventoryCount() >= this.inventoryCapacity();
    },
  };
}

function makePendingService(entries = []) {
  const state = {
    entries: cloneRows(entries),
    refreshCalls: [],
    invalidations: [],
    lockCalls: [],
    onForceRefresh: null,
  };

  return {
    state,
    hasClaimableItems() {
      return state.entries.length > 0;
    },
    async refreshPendingItems(forceRefresh = false) {
      state.refreshCalls.push(forceRefresh);
      if (typeof state.onForceRefresh === 'function') {
        const next = await state.onForceRefresh(forceRefresh, cloneRows(state.entries));
        if (Array.isArray(next)) {
          state.entries = cloneRows(next);
        }
      }
      return cloneRows(state.entries);
    },
    getPendingItemsSnapshot() {
      return cloneRows(state.entries);
    },
    invalidatePendingItems(reason = '') {
      state.invalidations.push(reason);
    },
    removePendingItemById(id) {
      state.entries = state.entries.filter(entry => entry.id !== id);
    },
    async withClaimLock(ctx, fn) {
      state.lockCalls.push(ctx.name);
      return fn();
    },
  };
}

function appendInventoryRows(currentRows, addedRows) {
  const byCode = new Map();
  for (const row of [...currentRows, ...addedRows]) {
    const code = row?.code;
    const quantity = Number(row?.quantity) || 0;
    if (!code || quantity <= 0) continue;
    byCode.set(code, (byCode.get(code) || 0) + quantity);
  }
  return [...byCode.entries()].map(([code, quantity]) => ({ code, quantity }));
}

async function testCanRunWhenPendingItemsCached() {
  const pendingSvc = makePendingService([makePendingEntry('reward-1', [{ code: 'copper_ore', quantity: 2 }])]);
  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
  });

  const routine = new DepositBankRoutine({ threshold: 0.9, sellToVendor: false });
  const ctx = makeCtx({
    inventory: [{ code: 'apple', quantity: 1 }],
    inventoryMaxItems: 20,
    maxSlots: 5,
  });

  assert.equal(routine.canRun(ctx), true, 'cached pending items should make deposit routine runnable');
  log('canRun becomes true when pending items are cached');
}

async function testClaimsPendingItemsAndDepositsOnlyClaimedRows() {
  const pendingSvc = makePendingService([
    makePendingEntry('reward-1', [{ code: 'copper_ore', quantity: 3 }]),
  ]);
  const calls = [];

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {
      calls.push('gear-refresh');
    },
    publishDesiredOrdersForCharacterFn: () => {
      calls.push('publish-orders');
    },
    depositAllFn: async () => {
      calls.push('deposit-all');
    },
    claimPendingItemFn: async (id, charName) => {
      calls.push(`claim:${id}:${charName}`);
      return {
        item: {
          id,
          gold: 0,
          items: [{ code: 'copper_ore', quantity: 3 }],
        },
        character: {
          inventory: [{ code: 'copper_ore', quantity: 3 }],
          inventory_max_items: 20,
          gold: 0,
        },
        cooldown: { remaining_seconds: 0 },
      };
    },
    waitForCooldownFn: async () => {
      calls.push('wait');
    },
    depositBankItemsFn: async (_ctx, rows) => {
      calls.push(`deposit-items:${rows.map(row => `${row.code}x${row.quantity}`).join(',')}`);
    },
    getSellRulesFn: () => null,
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: false, recycleEquipment: false, depositGold: false });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5 });

  await routine.execute(ctx);

  assert.deepEqual(calls, [
    'gear-refresh',
    'publish-orders',
    'claim:reward-1:Tester',
    'wait',
    'deposit-items:copper_orex3',
  ]);
  assert.deepEqual(pendingSvc.state.entries, [], 'claimed pending item should be removed from cache');
  log('successful pending claim deposits only the claimed rows');
}

async function testSkipsClaimWhenPendingQuantityWillNotFit() {
  const pendingSvc = makePendingService([
    makePendingEntry('too-big', [{ code: 'copper_ore', quantity: 6 }]),
  ]);
  let claimCalls = 0;
  let depositCalls = 0;

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {},
    publishDesiredOrdersForCharacterFn: () => {},
    claimPendingItemFn: async () => {
      claimCalls += 1;
      throw new Error('should not be called');
    },
    depositBankItemsFn: async () => {
      depositCalls += 1;
    },
    getSellRulesFn: () => null,
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: false, recycleEquipment: false, depositGold: false });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 5, maxSlots: 5 });

  await routine.execute(ctx);

  assert.equal(claimCalls, 0);
  assert.equal(depositCalls, 0);
  log('pending claims halt before quantity overflow');
}

async function testSkipsClaimWhenPendingNewItemNeedsMissingSlot() {
  const pendingSvc = makePendingService([
    makePendingEntry('new-slot-needed', [{ code: 'iron_ore', quantity: 1 }]),
  ]);
  let claimCalls = 0;

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({ apple: 1 }),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {},
    publishDesiredOrdersForCharacterFn: () => {},
    depositAllFn: async () => {},
    claimPendingItemFn: async () => {
      claimCalls += 1;
      throw new Error('should not be called');
    },
    getSellRulesFn: () => null,
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: false, recycleEquipment: false, depositGold: false });
  const ctx = makeCtx({
    inventory: [{ code: 'apple', quantity: 1 }],
    inventoryMaxItems: 20,
    maxSlots: 1,
  });

  await routine.execute(ctx);

  assert.equal(claimCalls, 0);
  log('pending claims halt before unique-slot overflow');
}

async function testRefreshesQueueAfterStale404AndContinues() {
  const entry1 = makePendingEntry('stale', [{ code: 'coal', quantity: 1 }]);
  const entry2 = makePendingEntry('fresh', [{ code: 'coal', quantity: 2 }], {
    created_at: '2026-03-04T12:00:00Z',
  });
  const pendingSvc = makePendingService([entry1, entry2]);
  const claimed = [];
  const deposited = [];

  pendingSvc.state.onForceRefresh = async (_forceRefresh, currentEntries) => {
    if (pendingSvc.state.invalidations.length > 0) {
      return currentEntries.filter(entry => entry.id !== 'stale');
    }
    return currentEntries;
  };

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {},
    publishDesiredOrdersForCharacterFn: () => {},
    claimPendingItemFn: async (id) => {
      if (id === 'stale') {
        const err = new Error('Pending item not found.');
        err.code = 404;
        throw err;
      }
      claimed.push(id);
      return {
        item: {
          id,
          gold: 0,
          items: [{ code: 'coal', quantity: 2 }],
        },
        character: {
          inventory: [{ code: 'coal', quantity: 2 }],
          inventory_max_items: 20,
          gold: 0,
        },
        cooldown: { remaining_seconds: 0 },
      };
    },
    waitForCooldownFn: async () => {},
    depositBankItemsFn: async (_ctx, rows) => {
      deposited.push(cloneRows(rows));
    },
    getSellRulesFn: () => null,
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: false, recycleEquipment: false, depositGold: false });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5 });

  await routine.execute(ctx);

  assert.deepEqual(pendingSvc.state.invalidations, ['claim 404 for stale']);
  assert.deepEqual(claimed, ['fresh']);
  assert.deepEqual(deposited, [[{ code: 'coal', quantity: 2 }]]);
  log('404 stale pending entries trigger a refresh and continue');
}

async function testInventoryErrorCodesStopClaimsGracefully(code) {
  const pendingSvc = makePendingService([
    makePendingEntry('blocked', [{ code: 'coal', quantity: 1 }]),
  ]);
  let depositCalls = 0;

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {},
    publishDesiredOrdersForCharacterFn: () => {},
    claimPendingItemFn: async () => {
      const err = new Error('Inventory full');
      err.code = code;
      throw err;
    },
    depositBankItemsFn: async () => {
      depositCalls += 1;
    },
    getSellRulesFn: () => null,
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: false, recycleEquipment: false, depositGold: false });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5 });

  await routine.execute(ctx);

  assert.equal(depositCalls, 0);
}

async function testPreservesRecycleSellAndGoldFlowAfterPendingClaims() {
  const pendingSvc = makePendingService([
    makePendingEntry('reward-1', [{ code: 'coal', quantity: 2 }], { gold: 25 }),
  ]);
  const order = [];

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {
      order.push('gear-refresh');
    },
    publishDesiredOrdersForCharacterFn: () => {
      order.push('publish-orders');
    },
    claimPendingItemFn: async (id, _charName) => {
      order.push(`claim:${id}`);
      return {
        item: {
          id,
          gold: 25,
          items: [{ code: 'coal', quantity: 2 }],
        },
        character: {
          inventory: [{ code: 'coal', quantity: 2 }],
          inventory_max_items: 20,
          gold: 25,
        },
        cooldown: { remaining_seconds: 0 },
      };
    },
    waitForCooldownFn: async () => {
      order.push('wait');
    },
    depositBankItemsFn: async (ctx) => {
      order.push('deposit-items');
      ctx.applyActionResult({
        character: {
          ...ctx.get(),
          inventory: [],
        },
      });
    },
    getSellRulesFn: () => ({ enabled: true }),
    executeRecycleFlowFn: async () => {
      order.push('recycle');
    },
    executeSellFlowFn: async () => {
      order.push('sell');
    },
    depositGoldToBankFn: async (ctx, quantity) => {
      order.push(`deposit-gold:${quantity}`);
      ctx.applyActionResult({
        character: {
          ...ctx.get(),
          gold: 0,
        },
      });
    },
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: true, recycleEquipment: true, depositGold: true });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5, gold: 0 });

  await routine.execute(ctx);

  assert.deepEqual(order, [
    'gear-refresh',
    'publish-orders',
    'claim:reward-1',
    'wait',
    'deposit-items',
    'recycle',
    'sell',
    'deposit-gold:25',
  ]);
  log('pending item recovery preserves recycle, GE sell, and gold deposit flow');
}

async function testNpcVendorSellRunsBeforeGe() {
  const pendingSvc = makePendingService([]);
  const order = [];

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {
      order.push('gear-refresh');
    },
    publishDesiredOrdersForCharacterFn: () => {
      order.push('publish-orders');
    },
    getSellRulesFn: () => ({ alwaysSell: [], neverSell: [] }),
    executeRecycleFlowFn: async () => {
      order.push('recycle');
    },
    executeNpcSellFlowFn: async () => {
      order.push('npc-sell');
    },
    executeSellFlowFn: async () => {
      order.push('ge-sell');
    },
    depositGoldToBankFn: async (ctx, quantity) => {
      order.push(`deposit-gold:${quantity}`);
      ctx.applyActionResult({
        character: {
          ...ctx.get(),
          gold: 0,
        },
      });
    },
  });

  const routine = new DepositBankRoutine({ sellToVendor: true, sellOnGE: true, recycleEquipment: true, depositGold: true });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5, gold: 40 });

  await routine.execute(ctx);

  assert.deepEqual(order, [
    'gear-refresh',
    'publish-orders',
    'recycle',
    'npc-sell',
    'ge-sell',
    'deposit-gold:40',
  ]);
  log('NPC vendor sell runs before GE in deposit flow');
}

async function testSellToVendorToggleSkipsNpcSellFlow() {
  const pendingSvc = makePendingService([]);
  let npcSellCalls = 0;
  let geSellCalls = 0;

  setDepositBankDeps({
    pendingItemsSvc: pendingSvc,
    getOwnedKeepByCodeForInventoryFn: () => ({}),
    getCharacterGearStateFn: () => null,
    equipmentCountsOnCharacterFn: () => new Map(),
    refreshGearStateFn: async () => {},
    publishDesiredOrdersForCharacterFn: () => {},
    getSellRulesFn: () => ({ alwaysSell: [], neverSell: [] }),
    executeRecycleFlowFn: async () => {},
    executeNpcSellFlowFn: async () => {
      npcSellCalls += 1;
    },
    executeSellFlowFn: async () => {
      geSellCalls += 1;
    },
  });

  const routine = new DepositBankRoutine({ sellToVendor: false, sellOnGE: true, recycleEquipment: true, depositGold: false });
  const ctx = makeCtx({ inventory: [], inventoryMaxItems: 20, maxSlots: 5 });

  await routine.execute(ctx);

  assert.equal(npcSellCalls, 0);
  assert.equal(geSellCalls, 1);
  log('sellToVendor toggle skips the NPC sell flow');
}

async function main() {
  try {
    resetDepositBankDeps();
    await testCanRunWhenPendingItemsCached();

    resetDepositBankDeps();
    await testClaimsPendingItemsAndDepositsOnlyClaimedRows();

    resetDepositBankDeps();
    await testSkipsClaimWhenPendingQuantityWillNotFit();

    resetDepositBankDeps();
    await testSkipsClaimWhenPendingNewItemNeedsMissingSlot();

    resetDepositBankDeps();
    await testRefreshesQueueAfterStale404AndContinues();

    resetDepositBankDeps();
    await testInventoryErrorCodesStopClaimsGracefully(497);
    log('497 inventory-full claim errors stop pending recovery gracefully');

    resetDepositBankDeps();
    await testInventoryErrorCodesStopClaimsGracefully(478);
    log('478 inventory-full claim errors stop pending recovery gracefully');

    resetDepositBankDeps();
    await testPreservesRecycleSellAndGoldFlowAfterPendingClaims();

    resetDepositBankDeps();
    await testNpcVendorSellRunsBeforeGe();

    resetDepositBankDeps();
    await testSellToVendorToggleSkipsNpcSellFlow();

    resetDepositBankDeps();
    console.log('\nDeposit bank routine tests passed');
  } catch (err) {
    resetDepositBankDeps();
    console.error('\nDeposit bank routine tests failed');
    throw err;
  }
}

await main();
