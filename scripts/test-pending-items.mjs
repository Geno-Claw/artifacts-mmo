#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const pendingItems = await import('../src/services/pending-items.mjs');

const {
  _resetForTests: resetPendingItems,
  _setApiClientForTests: setPendingApi,
  getPendingItemsSnapshot,
  hasClaimableItems,
  invalidatePendingItems,
  refreshPendingItems,
  removePendingItemById,
  withClaimLock,
} = pendingItems;

function log(label) {
  console.log(`  PASS  ${label}`);
}

function makeItem(id, createdAt, extra = {}) {
  return {
    id,
    account: 'acct',
    source: 'achievement',
    description: id,
    created_at: createdAt,
    items: [],
    gold: 0,
    ...extra,
  };
}

async function flushMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function testRefreshLoadsAllPagesOldestFirst() {
  const calls = [];
  setPendingApi({
    async getPendingItems({ page }) {
      calls.push(page);
      if (page === 1) {
        const rows = [];
        for (let i = 0; i < 98; i += 1) {
          rows.push(makeItem(`page1-${i}`, `2026-03-10T${String(i % 24).padStart(2, '0')}:00:00Z`));
        }
        rows.push(makeItem('late', '2026-03-05T12:00:00Z'));
        rows.push(makeItem('early', '2026-03-03T12:00:00Z'));
        return { data: rows };
      }
      if (page === 2) {
        return [
          makeItem('middle', '2026-03-04T12:00:00Z'),
        ];
      }
      return [];
    },
    async claimPendingItem() {
      throw new Error('not used');
    },
  });

  const items = await refreshPendingItems(true);
  assert.deepEqual(calls, [1, 2], 'should stop after the first short page');
  assert.deepEqual(items.slice(0, 3).map(item => item.id), ['early', 'middle', 'late']);
  assert.equal(hasClaimableItems({ allowBackgroundRefresh: false }), true);

  log('refresh loads all pages and sorts oldest-first');
}

async function testHasClaimableItemsSchedulesBackgroundRefresh() {
  let fetches = 0;
  setPendingApi({
    async getPendingItems() {
      fetches += 1;
      return [makeItem('queued', '2026-03-03T12:00:00Z')];
    },
    async claimPendingItem() {
      throw new Error('not used');
    },
  });

  invalidatePendingItems('background-refresh');
  assert.equal(hasClaimableItems(), false, 'stale cache should report current empty view immediately');
  await flushMicrotasks();
  assert.equal(fetches, 1, 'background refresh should start lazily');
  assert.equal(hasClaimableItems({ allowBackgroundRefresh: false }), true, 'cache should update after background refresh');

  log('hasClaimableItems triggers a background refresh when stale');
}

async function testRemovePendingItemById() {
  setPendingApi({
    async getPendingItems() {
      return [
        makeItem('a', '2026-03-03T12:00:00Z'),
        makeItem('b', '2026-03-04T12:00:00Z'),
      ];
    },
    async claimPendingItem() {
      throw new Error('not used');
    },
  });

  await refreshPendingItems(true);
  removePendingItemById('a');
  assert.deepEqual(getPendingItemsSnapshot().map(item => item.id), ['b']);

  log('removePendingItemById updates the cached queue');
}

async function testClaimLockSerializesCallers() {
  const events = [];
  let releaseFirst;
  const firstBlocker = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const first = withClaimLock({ name: 'Alpha' }, async () => {
    events.push('alpha:start');
    await firstBlocker;
    events.push('alpha:end');
  });

  const second = withClaimLock({ name: 'Beta' }, async () => {
    events.push('beta:start');
    events.push('beta:end');
  });

  await flushMicrotasks();
  assert.deepEqual(events, ['alpha:start'], 'second caller should wait for the first lock holder');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['alpha:start', 'alpha:end', 'beta:start', 'beta:end']);

  log('claim lock serializes concurrent claimers');
}

async function main() {
  try {
    resetPendingItems();
    await testRefreshLoadsAllPagesOldestFirst();

    resetPendingItems();
    await testHasClaimableItemsSchedulesBackgroundRefresh();

    resetPendingItems();
    await testRemovePendingItemById();

    resetPendingItems();
    await testClaimLockSerializesCallers();

    resetPendingItems();
    console.log('\nPending items tests passed');
  } catch (err) {
    resetPendingItems();
    console.error('\nPending items tests failed');
    throw err;
  }
}

await main();
