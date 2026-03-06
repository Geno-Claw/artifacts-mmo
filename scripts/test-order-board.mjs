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

    // Deposits from non-claimer now advance order (opportunistic contribution).
    const opportunistic = recordDeposits({
      charName: 'WorkerB',
      items: [{ code: 'copper_ore', quantity: 2 }],
    });
    assert.equal(opportunistic.length, 1, 'non-claimer deposits should advance order');
    assert.equal(opportunistic[0].quantity, 2);
    assert.equal(opportunistic[0].opportunistic, true, 'non-claimer contribution should be flagged as opportunistic');

    const progressed = recordDeposits({
      charName: 'WorkerA',
      items: [{ code: 'copper_ore', quantity: 2 }],
    });
    assert.equal(progressed.length, 1, 'claimer deposits should advance order');
    assert.equal(progressed[0].opportunistic, false, 'claimer contribution should not be opportunistic');

    let snapshot = getOrderBoardSnapshot();
    let order = snapshot.orders.find(row => row.id === first.id);
    assert.equal(order.remainingQty, 5, 'remaining qty should decrease by both deposits (9 - 2 - 2)');
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

    // --- Opportunistic contributions: open (unclaimed) order ---
    const openOrder = createOrMergeOrder({
      requesterName: 'CrafterC',
      recipeCode: 'wolf_hat',
      itemCode: 'wolf_pelt',
      sourceType: 'fight',
      sourceCode: 'wolf',
      sourceLevel: 20,
      quantity: 5,
    });
    assert.ok(openOrder, 'open order for opportunistic test should be created');
    assert.equal(openOrder.status, 'open');

    const openContrib = recordDeposits({
      charName: 'RandomChar',
      items: [{ code: 'wolf_pelt', quantity: 3 }],
    });
    assert.equal(openContrib.length, 1, 'deposits against open order should count');
    assert.equal(openContrib[0].opportunistic, true, 'open-order contribution should be opportunistic');
    assert.equal(openContrib[0].quantity, 3);

    snapshot = getOrderBoardSnapshot();
    const openOrderAfter = snapshot.orders.find(row => row.id === openOrder.id);
    assert.equal(openOrderAfter.remainingQty, 2, 'open order remaining should decrease (5 - 3)');

    // --- Claimer priority: claimer's own order is filled before others ---
    const priorityOrderA = createOrMergeOrder({
      requesterName: 'ReqA',
      recipeCode: 'test_recipe_a',
      itemCode: 'test_gem',
      sourceType: 'gather',
      sourceCode: 'gem_rocks',
      gatherSkill: 'mining',
      sourceLevel: 30,
      quantity: 5,
    });
    const priorityOrderB = createOrMergeOrder({
      requesterName: 'ReqB',
      recipeCode: 'test_recipe_b',
      itemCode: 'test_gem',
      sourceType: 'fight',
      sourceCode: 'gem_golem',
      sourceLevel: 30,
      quantity: 5,
    });
    // Claim order B
    const claimedB = claimOrder(priorityOrderB.id, { charName: 'PriorityWorker', leaseMs: 10_000 });
    assert.ok(claimedB, 'PriorityWorker should claim order B');

    // PriorityWorker deposits 3 test_gem — their claimed order B should be filled first
    const priorityResult = recordDeposits({
      charName: 'PriorityWorker',
      items: [{ code: 'test_gem', quantity: 3 }],
    });
    assert.equal(priorityResult.length, 1, 'claimer deposit should match their own order first');
    assert.equal(priorityResult[0].orderId, priorityOrderB.id, 'deposit should go to claimed order B');
    assert.equal(priorityResult[0].opportunistic, false, 'deposit to own claimed order is not opportunistic');

    // Now deposit more than order B needs — overflow should go to order A
    const overflowResult = recordDeposits({
      charName: 'PriorityWorker',
      items: [{ code: 'test_gem', quantity: 10 }],
    });
    assert.equal(overflowResult.length, 2, 'overflow should fill both orders');
    const ownOrderEntry = overflowResult.find(e => e.orderId === priorityOrderB.id);
    const otherOrderEntry = overflowResult.find(e => e.orderId === priorityOrderA.id);
    assert.ok(ownOrderEntry, 'own claimed order should be in results');
    assert.equal(ownOrderEntry.opportunistic, false);
    assert.ok(otherOrderEntry, 'other order should receive overflow');
    assert.equal(otherOrderEntry.opportunistic, true);

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

    const npcBuyOrder = createOrMergeOrder({
      requesterName: 'GenoClaw2',
      recipeCode: 'gear_state:GenoClaw2:burn_rune',
      itemCode: 'burn_rune',
      sourceType: 'npc_buy',
      sourceCode: 'rune_vendor',
      sourceLevel: 20,
      quantity: 1,
    });
    assert.ok(npcBuyOrder, 'npc_buy order should be created');
    const npcBuyClaimable = listClaimableOrders({
      sourceType: 'npc_buy',
      charName: 'MerchantX',
    });
    assert.equal(npcBuyClaimable.length, 1, 'npc_buy order should be claimable');
    assert.equal(npcBuyClaimable[0].sourceCode, 'rune_vendor');

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

    // --- task_exchange orders ---
    const exchangeOrder1 = createOrMergeOrder({
      requesterName: 'CrafterA',
      recipeCode: 'enchanted_ring',
      itemCode: 'jasper_crystal',
      sourceType: 'task_exchange',
      sourceCode: 'jasper_crystal',
      quantity: 3,
    });
    assert.ok(exchangeOrder1, 'task_exchange order should be created');
    assert.equal(exchangeOrder1.sourceType, 'task_exchange');
    assert.equal(exchangeOrder1.itemCode, 'jasper_crystal');
    assert.equal(exchangeOrder1.requestedQty, 3);
    assert.equal(exchangeOrder1.gatherSkill, null, 'task_exchange orders should have null gatherSkill');
    assert.equal(exchangeOrder1.craftSkill, null, 'task_exchange orders should have null craftSkill');

    // Merge from a different requester
    const exchangeMerged = createOrMergeOrder({
      requesterName: 'CrafterB',
      recipeCode: 'mystic_amulet',
      itemCode: 'jasper_crystal',
      sourceType: 'task_exchange',
      sourceCode: 'jasper_crystal',
      quantity: 2,
    });
    assert.equal(exchangeMerged.id, exchangeOrder1.id, 'task_exchange orders should merge by sourceType:sourceCode:itemCode');
    assert.equal(exchangeMerged.requestedQty, 5, 'merged task_exchange order should aggregate qty');

    // Claimable with sourceType filter
    const exchangeClaimable = listClaimableOrders({
      sourceType: 'task_exchange',
      charName: 'Worker1',
    });
    assert.equal(exchangeClaimable.length, 1, 'task_exchange order should be claimable');
    assert.equal(exchangeClaimable[0].sourceType, 'task_exchange');

    // Should not appear in gather/fight/craft queries
    const gatherClaimable = listClaimableOrders({ sourceType: 'gather', charName: 'Worker1' });
    const noExchangeInGather = gatherClaimable.filter(o => o.sourceType === 'task_exchange');
    assert.equal(noExchangeInGather.length, 0, 'task_exchange orders should not appear in gather queries');

    // Claim and fulfill via deposits
    const claimedExchange = claimOrder(exchangeOrder1.id, { charName: 'Worker1', leaseMs: 5_000 });
    assert.ok(claimedExchange, 'worker should claim task_exchange order');
    assert.equal(claimedExchange.status, 'claimed');

    const exchangeDeposit = recordDeposits({
      charName: 'Worker1',
      items: [{ code: 'jasper_crystal', quantity: 5 }],
    });
    assert.equal(exchangeDeposit.length, 1, 'deposits should match task_exchange orders');

    snapshot = getOrderBoardSnapshot();
    const fulfilledExchange = snapshot.orders.find(row => row.id === exchangeOrder1.id);
    assert.equal(fulfilledExchange.status, 'fulfilled', 'task_exchange order should be fulfilled');
    assert.equal(fulfilledExchange.remainingQty, 0);

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
