#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetOrderBoardForTests,
  claimOrder,
  clearOrderBoard,
  createOrMergeOrder,
  flushOrderBoard,
  getOrderBoardSnapshot,
  initializeOrderBoard,
  listClaimableOrders,
  markCharBlocked,
  recordDeposits,
  renewClaim,
} from '../src/services/order-board.mjs';

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), 'order-board-test-'));
  const boardPath = join(tempDir, 'order-board.json');

  try {
    _resetOrderBoardForTests();
    await initializeOrderBoard({ path: boardPath });

    const first = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'bronze_sword',
      itemCode: 'copper_ore',
      sourceType: 'gather',
      sourceCode: 'copper_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 3,
    });
    assert.ok(first, 'first order should be created');
    assert.equal(first.requestedQty, 3);
    assert.equal(first.remainingQty, 3);

    // Duplicate contribution from same requester+recipe grows only when quantity increases.
    const duplicate = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'bronze_sword',
      itemCode: 'copper_ore',
      sourceType: 'gather',
      sourceCode: 'copper_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 7,
    });
    assert.equal(duplicate.requestedQty, 7);
    assert.equal(duplicate.remainingQty, 7);

    const merged = createOrMergeOrder({
      requesterName: 'CrafterB',
      recipeCode: 'bronze_helmet',
      itemCode: 'copper_ore',
      sourceType: 'gather',
      sourceCode: 'copper_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 2,
    });
    assert.equal(merged.id, first.id, 'order should merge by source+item key');
    assert.equal(merged.requestedQty, 9, 'merged order should increase requested qty');
    assert.equal(merged.remainingQty, 9, 'merged order should increase remaining qty');

    const claimableForMiner = listClaimableOrders({
      sourceType: 'gather',
      gatherSkill: 'mining',
      charName: 'WorkerA',
    });
    assert.equal(claimableForMiner.length, 1);

    const claimed = claimOrder(first.id, { charName: 'WorkerA', leaseMs: 2_000 });
    assert.ok(claimed, 'worker should claim open order');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claim.charName, 'WorkerA');

    const secondClaim = claimOrder(first.id, { charName: 'WorkerB', leaseMs: 2_000 });
    assert.equal(secondClaim, null, 'another worker cannot claim while lease is active');

    const renewed = renewClaim(first.id, { charName: 'WorkerA', leaseMs: 3_000 });
    assert.ok(renewed, 'claimer should renew lease');
    assert.ok(renewed.claim.expiresAtMs > renewed.claim.claimedAtMs);

    // Deposits from non-claimer do not advance order.
    const ignored = recordDeposits({
      charName: 'WorkerB',
      items: [{ code: 'copper_ore', quantity: 2 }],
    });
    assert.equal(ignored.length, 0);

    const progressed = recordDeposits({
      charName: 'WorkerA',
      items: [{ code: 'copper_ore', quantity: 2 }],
    });
    assert.equal(progressed.length, 1, 'claimer deposits should advance order');

    let snapshot = getOrderBoardSnapshot();
    let order = snapshot.orders.find(row => row.id === first.id);
    assert.equal(order.remainingQty, 7, 'remaining qty should decrease only by deposited amount');
    assert.equal(order.status, 'claimed');

    markCharBlocked(first.id, { charName: 'WorkerA', blockedRetryMs: 2_000 });
    snapshot = getOrderBoardSnapshot();
    order = snapshot.orders.find(row => row.id === first.id);
    assert.equal(order.status, 'open', 'blocking claimer should release active claim');

    const blockedForA = listClaimableOrders({ sourceType: 'gather', gatherSkill: 'mining', charName: 'WorkerA' });
    assert.equal(blockedForA.length, 0, 'blocked worker should not see order as claimable');

    const claimByOther = claimOrder(first.id, { charName: 'WorkerB', leaseMs: 2_000 });
    assert.ok(claimByOther, 'unblocked worker should claim order');

    const fulfilledRows = recordDeposits({
      charName: 'WorkerB',
      items: [{ code: 'copper_ore', quantity: 99 }],
    });
    assert.equal(fulfilledRows.length, 1);

    snapshot = getOrderBoardSnapshot();
    order = snapshot.orders.find(row => row.id === first.id);
    assert.equal(order.status, 'fulfilled', 'order should be fulfilled once remaining reaches zero');
    assert.equal(order.remainingQty, 0);

    const noneClaimable = listClaimableOrders({ sourceType: 'gather', gatherSkill: 'mining', charName: 'WorkerB' });
    assert.equal(noneClaimable.length, 0, 'fulfilled order should not be claimable');

    const craftOrder = createOrMergeOrder({
      requesterName: 'GenoClaw1',
      recipeCode: 'gear_state:GenoClaw1:iron_shield',
      itemCode: 'iron_shield',
      sourceType: 'craft',
      sourceCode: 'iron_shield',
      craftSkill: 'gearcrafting',
      sourceLevel: 15,
      quantity: 2,
    });
    assert.ok(craftOrder, 'craft order should be created');
    const craftClaimable = listClaimableOrders({
      sourceType: 'craft',
      craftSkill: 'gearcrafting',
      charName: 'CrafterX',
    });
    assert.equal(craftClaimable.length, 1, 'craft order should be claimable by matching craft skill');
    assert.equal(craftClaimable[0].craftSkill, 'gearcrafting');

    const claimedCraft = claimOrder(craftOrder.id, { charName: 'CrafterX', leaseMs: 2_000 });
    assert.ok(claimedCraft, 'craft order should be claimable');
    const craftProgress = recordDeposits({
      charName: 'CrafterX',
      items: [{ code: 'iron_shield', quantity: 1 }],
    });
    assert.equal(craftProgress.length, 1, 'craft order should progress from deposits');

    await flushOrderBoard();

    // Persisted board should recover with stale claims reopened.
    const stalePayload = {
      version: 1,
      updatedAtMs: Date.now(),
      orders: [{
        id: 'stale-claim-order',
        mergeKey: 'fight:wolf:wolf_pelt',
        itemCode: 'wolf_pelt',
        sourceType: 'fight',
        sourceCode: 'wolf',
        sourceLevel: 20,
        requestedQty: 4,
        remainingQty: 4,
        status: 'claimed',
        requesters: ['CrafterC'],
        recipes: ['wolf_hat'],
        contributions: { 'CrafterC::wolf_hat': 4 },
        claim: {
          charName: 'WorkerZ',
          claimedAtMs: Date.now() - 10_000,
          leaseMs: 500,
          expiresAtMs: Date.now() - 1,
        },
        blockedByChar: {},
        createdAtMs: Date.now() - 20_000,
        updatedAtMs: Date.now() - 2_000,
        fulfilledAtMs: null,
      }],
    };
    writeFileSync(boardPath, `${JSON.stringify(stalePayload, null, 2)}\n`, 'utf-8');

    _resetOrderBoardForTests();
    await initializeOrderBoard({ path: boardPath });
    snapshot = getOrderBoardSnapshot();
    const staleOrder = snapshot.orders.find(row => row.id === 'stale-claim-order');
    assert.ok(staleOrder, 'stale persisted order should load');
    assert.equal(staleOrder.status, 'open', 'expired persisted claim should be reopened');
    assert.equal(staleOrder.claim, null, 'expired persisted claim should be cleared');

    const cleared = clearOrderBoard('test_clear');
    assert.equal(cleared.cleared >= 1, true, 'clearOrderBoard should clear active rows');
    assert.equal(getOrderBoardSnapshot().orders.length, 0, 'board should be empty after clear');

    console.log('test-order-board: PASS');
  } finally {
    _resetOrderBoardForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
