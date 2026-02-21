#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const { BANK } = await import('../src/data/locations.mjs');

const bankExpansionMod = await import('../src/routines/bank-expansion.mjs');
const { BankExpansionRoutine, _resetForTests, _getSharedState, _setPurchasing, _setBankDetails } = bankExpansionMod;

// --- Test state & mocks ---

const calls = {
  getBankDetails: 0,
  buyBankExpansion: [],
  withdrawGold: [],
  ensureAtBankCalls: 0,
};

let mockBankDetails = {
  slots: 50,
  expansions: 0,
  next_expansion_cost: 4500,
  gold: 10000,
};

let mockCharGold = 5000;
let mockCharPosition = { x: 0, y: 0 };
let buyExpansionError = null;

function resetMocks() {
  calls.getBankDetails = 0;
  calls.buyBankExpansion = [];
  calls.withdrawGold = [];
  calls.ensureAtBankCalls = 0;
  mockBankDetails = {
    slots: 50,
    expansions: 0,
    next_expansion_cost: 4500,
    gold: 10000,
  };
  mockCharGold = 5000;
  mockCharPosition = { x: 0, y: 0 };
  buyExpansionError = null;
}

const fakeApi = {
  async getBankDetails() {
    calls.getBankDetails++;
    return { ...mockBankDetails };
  },
  async buyBankExpansion(name) {
    if (buyExpansionError) {
      const err = new Error(buyExpansionError.message || 'error');
      err.code = buyExpansionError.code;
      throw err;
    }
    calls.buyBankExpansion.push(name);
    return { cooldown: { remaining_seconds: 0 } };
  },
  async withdrawGold(quantity, name) {
    calls.withdrawGold.push({ quantity, name });
    mockCharGold += quantity;
    return { cooldown: { remaining_seconds: 0 } };
  },
};

function makeCtx(name = 'TestChar') {
  return {
    name,
    get() {
      return {
        name,
        x: mockCharPosition.x,
        y: mockCharPosition.y,
        gold: mockCharGold,
        hp: 100,
        max_hp: 100,
        level: 10,
        inventory_max_items: 100,
        inventory: [],
      };
    },
    async refresh() {},
    hpPercent() { return 100; },
    isAt(x, y) { return mockCharPosition.x === x && mockCharPosition.y === y; },
    inventoryCount() { return 0; },
    inventoryCapacity() { return 100; },
    inventoryFull() { return false; },
    settings() { return { potions: { bankTravel: { enabled: false } } }; },
  };
}

function reset() {
  resetMocks();
  _resetForTests();
}

// Testable subclass that uses fakeApi instead of real imports.
class TestableExpansionRoutine extends BankExpansionRoutine {
  async _doExecute(ctx) {
    const details = await fakeApi.getBankDetails();
    _setBankDetails(details);
    const cost = details.next_expansion_cost;
    const charGold = ctx.get().gold;
    const bankGold = details.gold || 0;
    const totalGold = charGold + bankGold;

    if (cost > totalGold * this.maxGoldPct) {
      this._lastResult = 'skip_expensive';
      return;
    }

    if (totalGold - cost < this.goldBuffer) {
      this._lastResult = 'skip_buffer';
      return;
    }

    // Simulate ensureAtBank
    calls.ensureAtBankCalls++;
    mockCharPosition = { x: BANK.x, y: BANK.y };

    // Withdraw gold if needed
    if (charGold < cost) {
      const needed = cost - charGold;
      await fakeApi.withdrawGold(needed, ctx.name);
    }

    // Buy expansion
    try {
      await fakeApi.buyBankExpansion(ctx.name);
      await ctx.refresh();
      _setBankDetails(null); // Clear cache like real routine does after purchase
      this._lastResult = 'purchased';
    } catch (err) {
      if (err.code === 492) {
        this._lastResult = 'error_492';
      } else if (err.code === 598) {
        this._lastResult = 'error_598';
      } else {
        throw err;
      }
    }
  }
}

// --- Tests ---

let passed = 0;
let failed = 0;

async function test(name, fn) {
  reset();
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
    failed++;
  }
}

console.log('Bank Expansion Routine Tests\n');

// --- canRun tests ---

console.log('canRun():');

await test('returns false when _purchasing is true', () => {
  _setPurchasing(true);
  const routine = new BankExpansionRoutine({ checkIntervalMs: 0 });
  const ctx = makeCtx();
  assert.equal(routine.canRun(ctx), false);
});

await test('returns true when cache is expired (triggers execute to fetch)', () => {
  const routine = new BankExpansionRoutine({ checkIntervalMs: 0 });
  const ctx = makeCtx();
  assert.equal(routine.canRun(ctx), true);
});

await test('returns true when cache is missing', () => {
  const routine = new BankExpansionRoutine({ checkIntervalMs: 300000 });
  const ctx = makeCtx();
  assert.equal(routine.canRun(ctx), true);
});

await test('returns false when cached and cost exceeds maxGoldPct', async () => {
  // Populate cache by running execute first
  mockCharGold = 2000;
  mockBankDetails.gold = 3000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ checkIntervalMs: 600_000, maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx);
  // 4500 > 5000 * 0.7 = 3500 → execute skips, but cache is now populated

  // Reset _purchasing (cleared by finally block already) and check canRun
  assert.equal(routine.canRun(ctx), false); // still too expensive
});

await test('returns true when cached and affordable', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ checkIntervalMs: 600_000, maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx);
  // 4500 <= 15000 * 0.7 = 10500 → purchased, but cache cleared after purchase

  // After successful purchase, cache is cleared → canRun returns true (no cache)
  assert.equal(routine.canRun(ctx), true);
});

// --- execute tests ---

console.log('\nexecute():');

await test('skips when cost exceeds maxGoldPct of total gold', async () => {
  mockCharGold = 2000;
  mockBankDetails.gold = 3000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx);

  // 4500 > 5000 * 0.7 = 3500 → skip
  assert.equal(routine._lastResult, 'skip_expensive');
  assert.equal(calls.buyBankExpansion.length, 0);
});

await test('purchases expansion when affordable with enough character gold', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx);

  assert.equal(routine._lastResult, 'purchased');
  assert.equal(calls.buyBankExpansion.length, 1);
  assert.equal(calls.buyBankExpansion[0], 'TestChar');
  assert.equal(calls.withdrawGold.length, 0); // had enough char gold
  assert.equal(calls.ensureAtBankCalls, 1);
});

await test('withdraws gold from bank when character gold insufficient', async () => {
  mockCharGold = 1000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx);

  assert.equal(routine._lastResult, 'purchased');
  assert.equal(calls.buyBankExpansion.length, 1);
  assert.equal(calls.withdrawGold.length, 1);
  assert.equal(calls.withdrawGold[0].quantity, 3500); // 4500 - 1000
});

await test('handles error 492 (insufficient gold) gracefully', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;
  buyExpansionError = { code: 492, message: 'Insufficient gold' };

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx); // should not throw
  assert.equal(routine._lastResult, 'error_492');
});

await test('handles error 598 (not at bank) gracefully', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;
  buyExpansionError = { code: 598, message: 'Not at bank' };

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await routine.execute(ctx); // should not throw
  assert.equal(routine._lastResult, 'error_598');
});

await test('skips when goldBuffer would not be met', async () => {
  // totalGold = 5000 + 1000 = 6000, cost = 4500, remainder = 1500 < buffer 2000
  mockCharGold = 5000;
  mockBankDetails.gold = 1000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.9, goldBuffer: 2000 });
  const ctx = makeCtx();
  await routine.execute(ctx);

  assert.equal(routine._lastResult, 'skip_buffer');
  assert.equal(calls.buyBankExpansion.length, 0);
});

await test('purchases when goldBuffer is satisfied', async () => {
  // totalGold = 5000 + 10000 = 15000, cost = 4500, remainder = 10500 >= buffer 5000
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7, goldBuffer: 5000 });
  const ctx = makeCtx();
  await routine.execute(ctx);

  assert.equal(routine._lastResult, 'purchased');
  assert.equal(calls.buyBankExpansion.length, 1);
});

await test('rethrows unknown errors', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;
  buyExpansionError = { code: 999, message: 'Unknown' };

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();
  await assert.rejects(() => routine.execute(ctx), { code: 999 });
});

// --- Coordination tests ---

console.log('\nCoordination:');

await test('_purchasing flag prevents concurrent canRun', () => {
  const routine1 = new BankExpansionRoutine({ checkIntervalMs: 0 });
  const routine2 = new BankExpansionRoutine({ checkIntervalMs: 0 });
  const ctx1 = makeCtx('Char1');
  const ctx2 = makeCtx('Char2');

  assert.equal(routine1.canRun(ctx1), true);
  assert.equal(routine2.canRun(ctx2), true);

  _setPurchasing(true);
  assert.equal(routine1.canRun(ctx1), false);
  assert.equal(routine2.canRun(ctx2), false);

  _setPurchasing(false);
  assert.equal(routine1.canRun(ctx1), true);
});

await test('execute sets and clears _purchasing flag', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();

  assert.equal(_getSharedState().purchasing, false);
  await routine.execute(ctx);
  assert.equal(_getSharedState().purchasing, false);
});

await test('execute clears _purchasing even on error (try/finally)', async () => {
  mockCharGold = 5000;
  mockBankDetails.gold = 10000;
  mockBankDetails.next_expansion_cost = 4500;
  buyExpansionError = { code: 999, message: 'Unexpected error' };

  const routine = new TestableExpansionRoutine({ maxGoldPct: 0.7 });
  const ctx = makeCtx();

  try {
    await routine.execute(ctx);
  } catch {
    // Expected — unknown error code re-thrown
  }

  assert.equal(_getSharedState().purchasing, false);
});

// --- Config defaults ---

console.log('\nConfig defaults:');

await test('default config values', () => {
  const routine = new BankExpansionRoutine();
  assert.equal(routine.name, 'Bank Expansion');
  assert.equal(routine.priority, 45);
  assert.equal(routine.loop, false);
  assert.equal(routine.checkIntervalMs, 300_000);
  assert.equal(routine.maxGoldPct, 0.7);
  assert.equal(routine.goldBuffer, 0);
});

await test('custom config values', () => {
  const routine = new BankExpansionRoutine({
    priority: 30,
    checkIntervalMs: 60_000,
    maxGoldPct: 0.5,
    goldBuffer: 10000,
  });
  assert.equal(routine.priority, 30);
  assert.equal(routine.checkIntervalMs, 60_000);
  assert.equal(routine.maxGoldPct, 0.5);
  assert.equal(routine.goldBuffer, 10000);
});

// --- Summary ---

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
