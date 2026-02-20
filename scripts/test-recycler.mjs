#!/usr/bin/env node
import assert from 'node:assert/strict';

const recycler = await import('../src/services/recycler.mjs');

const {
  _resetForTests,
  _setDepsForTests,
  analyzeRecycleCandidates,
  executeRecycleFlow,
} = recycler;

function makeCtx(name = 'Recycler', capacity = 100) {
  const inventory = new Map();

  function addInventory(code, quantity) {
    const qty = Number(quantity) || 0;
    if (!code || qty <= 0) return;
    inventory.set(code, (inventory.get(code) || 0) + qty);
  }

  function removeInventory(code, quantity) {
    const qty = Number(quantity) || 0;
    if (!code || qty <= 0) return;
    const next = (inventory.get(code) || 0) - qty;
    if (next > 0) inventory.set(code, next);
    else inventory.delete(code);
  }

  return {
    name,
    addInventory,
    removeInventory,
    itemCount(code) {
      return inventory.get(code) || 0;
    },
    inventoryCount() {
      let total = 0;
      for (const qty of inventory.values()) total += qty;
      return total;
    },
    inventoryCapacity() {
      return capacity;
    },
    get() {
      return {
        inventory: [...inventory.entries()].map(([code, quantity]) => ({ code, quantity })),
      };
    },
    async refresh() {},
  };
}

function installAnalyzeDeps({
  sellRules,
  itemsByCode,
  claimedByCode,
  globalByCode,
  bankByCode,
  levelsByChar = {},
  needsByCode = new Map(),
  latestBySkill = new Map(),
  targetsByCode = new Map(),
}) {
  _setDepsForTests({
    getSellRulesFn: () => sellRules,
    gameDataSvc: {
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
      isEquipmentType(item) {
        return item?.type === 'weapon' || item?.type === 'ring' || item?.type === 'amulet';
      },
    },
    getClaimedTotalFn: (code) => claimedByCode.get(code) || 0,
    globalCountFn: (code) => globalByCode.get(code) || 0,
    bankCountFn: (code) => bankByCode.get(code) || 0,
    getCharacterLevelsSnapshotFn: () => levelsByChar,
    computeToolNeedsByCodeFn: () => needsByCode,
    computeLatestToolBySkillFn: () => latestBySkill,
    computeToolTargetsByCodeFn: () => targetsByCode,
  });
}

async function testAnalyzeUsesClaimBasedProtection() {
  _resetForTests();

  const bankItems = new Map([
    ['claimed_blade', 3],
    ['free_ring', 2],
    ['never_sell_blade', 4],
    ['copper_ore', 25],
  ]);

  installAnalyzeDeps({
    sellRules: {
      sellDuplicateEquipment: true,
      neverSell: ['never_sell_blade'],
    },
    itemsByCode: new Map([
      ['claimed_blade', { code: 'claimed_blade', type: 'weapon', craft: { skill: 'gearcrafting' } }],
      ['free_ring', { code: 'free_ring', type: 'ring', craft: { skill: 'gearcrafting' } }],
      ['never_sell_blade', { code: 'never_sell_blade', type: 'weapon', craft: { skill: 'gearcrafting' } }],
      ['copper_ore', { code: 'copper_ore', type: 'resource' }],
    ]),
    claimedByCode: new Map([
      ['claimed_blade', 2],
      ['free_ring', 0],
      ['never_sell_blade', 0],
    ]),
    globalByCode: new Map([
      ['claimed_blade', 3],
      ['free_ring', 2],
      ['never_sell_blade', 4],
      ['copper_ore', 25],
    ]),
    bankByCode: bankItems,
  });

  const rows = analyzeRecycleCandidates({ name: 'Recycler' }, bankItems);
  rows.sort((a, b) => a.code.localeCompare(b.code));

  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [
      { code: 'claimed_blade', quantity: 1 },
      { code: 'free_ring', quantity: 2 },
    ],
    'candidates should exclude never-sell and keep claimed quantities',
  );
}

async function testAnalyzeTreatsFallbackClaimsAsProtected() {
  _resetForTests();

  const bankItems = new Map([
    ['sticky_sword', 1],
  ]);

  installAnalyzeDeps({
    sellRules: {
      sellDuplicateEquipment: true,
      neverSell: [],
    },
    itemsByCode: new Map([
      ['sticky_sword', { code: 'sticky_sword', type: 'weapon', craft: { skill: 'gearcrafting' } }],
    ]),
    // Simulates transition-safe "available" claim while upgrade is still desired.
    claimedByCode: new Map([
      ['sticky_sword', 1],
    ]),
    globalByCode: new Map([
      ['sticky_sword', 1],
    ]),
    bankByCode: bankItems,
  });

  const rows = analyzeRecycleCandidates({ name: 'Recycler' }, bankItems);
  assert.equal(rows.length, 0, 'fully-claimed fallback gear should not be selected for recycle');
}

async function testAnalyzeToolSurplusRespectsReservesAndLowerTierNeeds() {
  _resetForTests();

  const bankItems = new Map([
    ['stone_pick', 4],
    ['iron_pick', 9],
  ]);

  installAnalyzeDeps({
    sellRules: {
      sellDuplicateEquipment: true,
      neverSell: [],
    },
    itemsByCode: new Map([
      ['stone_pick', { code: 'stone_pick', type: 'weapon', subtype: 'tool', craft: { skill: 'weaponcrafting' } }],
      ['iron_pick', { code: 'iron_pick', type: 'weapon', subtype: 'tool', craft: { skill: 'weaponcrafting' } }],
    ]),
    claimedByCode: new Map([
      ['stone_pick', 0],
      ['iron_pick', 0],
    ]),
    globalByCode: new Map([
      ['stone_pick', 4],
      ['iron_pick', 9],
    ]),
    bankByCode: bankItems,
    levelsByChar: {
      Low: 5,
      High: 25,
    },
    needsByCode: new Map([
      ['stone_pick', 1],
      ['iron_pick', 2],
    ]),
    latestBySkill: new Map([
      ['mining', { code: 'iron_pick', level: 10 }],
    ]),
    targetsByCode: new Map([
      ['stone_pick', 1],
      ['iron_pick', 5],
    ]),
  });

  const rows = analyzeRecycleCandidates({ name: 'Recycler' }, bankItems);
  rows.sort((a, b) => a.code.localeCompare(b.code));

  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [
      { code: 'iron_pick', quantity: 4 },
      { code: 'stone_pick', quantity: 3 },
    ],
    'tool candidates should keep lower-tier needs and reserve 5 latest-tier copies in bank',
  );
}

async function testAnalyzeToolSurplusStillHonorsClaimedProtection() {
  _resetForTests();

  const bankItems = new Map([
    ['iron_pick', 7],
  ]);

  installAnalyzeDeps({
    sellRules: {
      sellDuplicateEquipment: true,
      neverSell: [],
    },
    itemsByCode: new Map([
      ['iron_pick', { code: 'iron_pick', type: 'weapon', subtype: 'tool', craft: { skill: 'weaponcrafting' } }],
    ]),
    claimedByCode: new Map([
      ['iron_pick', 6],
    ]),
    globalByCode: new Map([
      ['iron_pick', 7],
    ]),
    bankByCode: bankItems,
    needsByCode: new Map([
      ['iron_pick', 2],
    ]),
    latestBySkill: new Map([
      ['mining', { code: 'iron_pick', level: 10 }],
    ]),
    targetsByCode: new Map([
      ['iron_pick', 5],
    ]),
  });

  const rows = analyzeRecycleCandidates({ name: 'Recycler' }, bankItems);
  assert.equal(rows.length, 1, 'tool should still be recyclable when above claimed quantity');
  assert.equal(rows[0].code, 'iron_pick');
  assert.equal(rows[0].quantity, 1, 'claimed tool quantities must be protected before recycling');
}

async function testExecuteRecycleFlowPushesBankTowardUniqueSlotTarget() {
  _resetForTests();

  const ctx = makeCtx('PressureRecycler', 100);
  const state = {
    bank: new Map(),
    moveCalls: [],
    recycleCalls: [],
    depositCalls: [],
  };

  for (let i = 1; i <= 44; i++) {
    state.bank.set(`filler_${i}`, 1);
  }
  state.bank.set('recyclable_blade', 1);
  state.bank.set('iron_scrap', 10);
  assert.equal(state.bank.size, 46, 'test fixture should start above slot pressure target');

  _setDepsForTests({
    getSellRulesFn: () => ({
      sellDuplicateEquipment: true,
      neverSell: [],
    }),
    gameDataSvc: {
      async getWorkshops() {
        return { gearcrafting: { x: 7, y: 7 } };
      },
      async getBankItems() {
        return new Map(state.bank);
      },
      getItem(code) {
        if (code === 'recyclable_blade') {
          return { code, type: 'weapon', craft: { skill: 'gearcrafting' } };
        }
        if (code === 'iron_scrap') {
          return { code, type: 'resource' };
        }
        return { code, type: 'resource' };
      },
      isEquipmentType(item) {
        return item?.type === 'weapon' || item?.type === 'ring' || item?.type === 'amulet';
      },
    },
    getClaimedTotalFn: (code) => (code === 'recyclable_blade' ? 0 : 0),
    globalCountFn: (code) => (state.bank.get(code) || 0) + ctx.itemCount(code),
    bankCountFn: (code) => state.bank.get(code) || 0,
    withdrawBankItemsFn: async (_ctx, rows) => {
      const withdrawn = [];
      for (const row of rows) {
        const code = row.code;
        const qty = Number(row.quantity) || 0;
        const available = state.bank.get(code) || 0;
        const used = Math.min(available, qty);
        if (used <= 0) continue;
        const next = available - used;
        if (next > 0) state.bank.set(code, next);
        else state.bank.delete(code);
        ctx.addInventory(code, used);
        withdrawn.push({ code, quantity: used });
      }
      return { withdrawn, skipped: [], failed: [] };
    },
    moveToFn: async (_ctx, x, y) => {
      state.moveCalls.push({ x, y });
    },
    recycleFn: async (code, qty) => {
      state.recycleCalls.push({ code, qty });
      ctx.removeInventory(code, qty);
      ctx.addInventory('iron_scrap', qty);
      return { cooldown: { remaining_seconds: 0 } };
    },
    waitForCooldownFn: async () => {},
    depositBankItemsFn: async (_ctx, rows) => {
      state.depositCalls.push(rows.map(row => ({ ...row })));
      for (const row of rows) {
        const code = row.code;
        const qty = Number(row.quantity) || 0;
        if (!code || qty <= 0) continue;
        ctx.removeInventory(code, qty);
        state.bank.set(code, (state.bank.get(code) || 0) + qty);
      }
    },
  });

  const recycled = await executeRecycleFlow(ctx);
  assert.equal(recycled, 1, 'one recyclable code should be processed');
  assert.equal(state.recycleCalls.length, 1, 'recycle action should run exactly once');
  assert.equal(state.recycleCalls[0].code, 'recyclable_blade');
  assert.equal(state.moveCalls.length >= 1, true, 'recycler should travel to matching workshop');
  assert.equal(state.bank.has('recyclable_blade'), false, 'recycled equipment should be removed from bank');
  assert.equal(state.bank.size <= 45, true, 'bank unique codes should be pushed at or below 45 when possible');
}

async function testClaimedEquipmentIsProtectedFromRecycle() {
  _resetForTests();

  const ctx = makeCtx('ClaimProtector', 100);
  const state = {
    bank: new Map(),
    recycleCalls: [],
  };

  for (let i = 1; i <= 45; i++) {
    state.bank.set(`filler_${i}`, 1);
  }
  state.bank.set('claimed_blade', 1);
  assert.equal(state.bank.size, 46);

  _setDepsForTests({
    getSellRulesFn: () => ({
      sellDuplicateEquipment: true,
      neverSell: [],
    }),
    gameDataSvc: {
      async getWorkshops() {
        return { gearcrafting: { x: 7, y: 7 } };
      },
      async getBankItems() {
        return new Map(state.bank);
      },
      getItem(code) {
        if (code === 'claimed_blade') {
          return { code, type: 'weapon', craft: { skill: 'gearcrafting' } };
        }
        return { code, type: 'resource' };
      },
      isEquipmentType(item) {
        return item?.type === 'weapon' || item?.type === 'ring' || item?.type === 'amulet';
      },
    },
    getClaimedTotalFn: (code) => (code === 'claimed_blade' ? 1 : 0),
    globalCountFn: (code) => (state.bank.get(code) || 0) + ctx.itemCount(code),
    bankCountFn: (code) => state.bank.get(code) || 0,
    withdrawBankItemsFn: async () => ({ withdrawn: [], skipped: [], failed: [] }),
    moveToFn: async () => {},
    recycleFn: async (code, qty) => {
      state.recycleCalls.push({ code, qty });
      return { cooldown: { remaining_seconds: 0 } };
    },
    waitForCooldownFn: async () => {},
    depositBankItemsFn: async () => {},
  });

  const recycled = await executeRecycleFlow(ctx);
  assert.equal(recycled, 0, 'claimed equipment should not be recycled');
  assert.equal(state.recycleCalls.length, 0, 'no recycle action should run for fully-claimed equipment');
  assert.equal(state.bank.has('claimed_blade'), true, 'claimed equipment remains in bank');
}

async function run() {
  await testAnalyzeUsesClaimBasedProtection();
  await testAnalyzeTreatsFallbackClaimsAsProtected();
  await testAnalyzeToolSurplusRespectsReservesAndLowerTierNeeds();
  await testAnalyzeToolSurplusStillHonorsClaimedProtection();
  await testExecuteRecycleFlowPushesBankTowardUniqueSlotTarget();
  await testClaimedEquipmentIsProtectedFromRecycle();
  _resetForTests();
  console.log('test-recycler: PASS');
}

run().catch((err) => {
  _resetForTests();
  console.error(err);
  process.exit(1);
});
