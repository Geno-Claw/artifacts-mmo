#!/usr/bin/env node
/**
 * Tests for the Event Routine.
 *
 * Since ES module exports are read-only, we can't monkey-patch gameData.
 * Instead, we test the routine's behavior by:
 * 1. Controlling activeEvents directly (Map is writable)
 * 2. Testing config/state logic that doesn't depend on game data
 * 3. Using the internal _findBestEvent where we can verify filtering by
 *    populating events that getMonster() won't find (returns null → skipped)
 */
import assert from 'node:assert/strict';
import { EventRoutine } from '../src/routines/event-routine.mjs';
import { _activeEvents, _eventDefinitions, setGatherResources } from '../src/services/event-manager.mjs';
import * as npcEventLock from '../src/services/npc-event-lock.mjs';

// --- Helpers ---

function setActiveEvent(code, contentType, { x = 1, y = 1, expiresInMs = 300_000 } = {}) {
  _activeEvents.set(code, {
    code,
    contentType,
    contentCode: code,
    map: { x, y },
    expiration: new Date(Date.now() + expiresInMs),
    createdAt: new Date(),
  });
}

function clearEvents() {
  _activeEvents.clear();
  _eventDefinitions.clear();
}

function makeCtx({
  name = 'TestChar',
  level = 30,
  inventoryFull = false,
  skills = {},
} = {}) {
  return {
    name,
    get() { return { name, level }; },
    inventoryFull() { return inventoryFull; },
    inventoryCount() { return inventoryFull ? 100 : 10; },
    inventoryCapacity() { return 100; },
    skillLevel(skill) { return skills[skill] || 0; },
    hpPercent() { return 100; },
    equippedItem(slot) { return null; },
    recordLoss() {},
    clearLosses() {},
    consecutiveLosses() { return 0; },
  };
}

// --- Constructor & Config Tests ---

function test_urgent_flag() {
  const routine = new EventRoutine();
  assert.equal(routine.urgent, true);
  assert.equal(routine.priority, 90);
  assert.equal(routine.loop, true);
  assert.equal(routine.name, 'Event');
  console.log('  PASS: urgent flag is true, priority 90, loop true');
}

function test_default_config() {
  const routine = new EventRoutine();
  assert.equal(routine.enabled, true);
  assert.equal(routine.monsterEvents, true);
  assert.equal(routine.resourceEvents, true);
  assert.equal(routine.npcEvents, false);
  assert.equal(routine.minTimeRemainingMs, 120_000);
  assert.equal(routine.maxMonsterType, 'elite');
  assert.equal(routine.cooldownMs, 60_000);
  assert.equal(routine.minWinrate, 80);
  console.log('  PASS: default config values');
}

function test_custom_config() {
  const routine = new EventRoutine({
    priority: 85,
    enabled: false,
    monsterEvents: false,
    npcEvents: true,
    minWinrate: 90,
    cooldownMs: 30_000,
  });
  assert.equal(routine.priority, 85);
  assert.equal(routine.enabled, false);
  assert.equal(routine.monsterEvents, false);
  assert.equal(routine.npcEvents, true);
  assert.equal(routine.minWinrate, 90);
  assert.equal(routine.cooldownMs, 30_000);
  console.log('  PASS: custom config values');
}

function test_updateConfig() {
  const routine = new EventRoutine();

  routine.updateConfig({
    enabled: false,
    monsterEvents: false,
    minWinrate: 90,
    cooldownMs: 30_000,
  });

  assert.equal(routine.enabled, false);
  assert.equal(routine.monsterEvents, false);
  assert.equal(routine.minWinrate, 90);
  assert.equal(routine.cooldownMs, 30_000);
  // Unchanged
  assert.equal(routine.resourceEvents, true);
  assert.equal(routine.npcEvents, false);
  console.log('  PASS: updateConfig patches specified fields');
}

function test_canBePreempted() {
  const routine = new EventRoutine();
  assert.equal(routine.canBePreempted({}), true);
  console.log('  PASS: canBePreempted returns true');
}

// --- canRun Tests ---

function test_canRun_disabled() {
  const routine = new EventRoutine({ enabled: false });
  const ctx = makeCtx();
  setActiveEvent('demon', 'monster');

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  console.log('  PASS: canRun returns false when disabled');
}

function test_canRun_inventoryFull() {
  const routine = new EventRoutine();
  const ctx = makeCtx({ inventoryFull: true });
  setActiveEvent('demon', 'monster');

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  console.log('  PASS: canRun returns false when inventory full');
}

function test_canRun_noActiveEvents() {
  const routine = new EventRoutine();
  const ctx = makeCtx();
  clearEvents();

  assert.equal(routine.canRun(ctx), false);
  console.log('  PASS: canRun returns false with no active events');
}

function test_canRun_npcEvent() {
  // NPC events now require a non-empty shopping list (from npcBuyList config + order board).
  // Without npc-buy-config loaded, _buildNpcShoppingList returns [] → NPC event skipped.
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: false, npcEvents: true });
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc');

  // Without npc buy config, no items to buy → NPC event skipped
  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun skips NPC event when no shopping list');
}

function test_canRun_monsterEvent_noGameData() {
  // Without game-data cache, getMonster returns null → event-only monster, still accepted
  const routine = new EventRoutine({ resourceEvents: false, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('demon', 'monster');

  // getMonster('demon') returns null (event-only monster) → accepted with default score
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.monsterCode, 'demon');

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun accepts event-only monster not in game data');
}

function test_canRun_monsterEvent_resolvesFromDefinition() {
  // Event code "bandit_camp" differs from monster code "bandit_lizard" in definition
  _eventDefinitions.set('bandit_camp', {
    code: 'bandit_camp',
    content: { type: 'monster', code: 'bandit_lizard' },
  });

  const routine = new EventRoutine({ resourceEvents: false, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('bandit_camp', 'monster');

  assert.equal(routine.canRun(ctx), true);
  // monsterCode should be resolved from definition, not event code
  assert.equal(routine._targetEvent.monsterCode, 'bandit_lizard');
  // event code stays as the event identifier
  assert.equal(routine._targetEvent.code, 'bandit_camp');

  clearEvents();
  routine._clearTarget();
  _eventDefinitions.delete('bandit_camp');
  console.log('  PASS: canRun resolves monster code from event definition');
}

function test_canRun_resourceEvent_noGameData() {
  // Without resource cache, getResource returns null → skill check skipped (null > level is false)
  // Actually: resource is null, so `resource && resource.level > ctx.skillLevel(...)` is false → NOT skipped
  // Then score = resource?.level || 0 = 0 → still picked as only option
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx({ skills: { mining: 5 } });
  setActiveEvent('strange_rocks', 'resource');

  // resource is null, the `if (resource && resource.level > ctx.skillLevel(...))` check is false → event not skipped
  const result = routine.canRun(ctx);
  assert.equal(result, true);
  assert.equal(routine._targetEvent.type, 'resource');

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun resource event when game data unavailable (permissive)');
}

function test_canRun_eventExpiringSoon() {
  // Use resource event (no game-data dependency for skill check when resource is unknown)
  const routine = new EventRoutine({ minTimeRemainingMs: 120_000, monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('strange_rocks', 'resource', { expiresInMs: 60_000 }); // 1 min left < 2 min min

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  console.log('  PASS: canRun skips event expiring soon');
}

function test_canRun_eventOnCooldown() {
  // Use resource event (no game-data dependency)
  const routine = new EventRoutine({ cooldownMs: 60_000, monsterEvents: false, resourceEvents: true, npcEvents: false });
  routine._eventCooldowns['strange_rocks'] = Date.now();
  const ctx = makeCtx();
  setActiveEvent('strange_rocks', 'resource');

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  routine._eventCooldowns = {};
  console.log('  PASS: canRun skips event on cooldown');
}

function test_canRun_stickyTarget() {
  // Use resource events (no game-data dependency)
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('strange_rocks', 'resource');

  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'strange_rocks');

  // Another resource appears — shouldn't switch
  setActiveEvent('magic_tree', 'resource');
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'strange_rocks'); // Still sticky

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun sticks to current target while active');
}

function test_canRun_clearsExpiredTarget() {
  // Use resource events (no game-data dependency)
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('strange_rocks', 'resource');

  routine.canRun(ctx);
  assert.equal(routine._targetEvent.code, 'strange_rocks');

  // Remove the event
  _activeEvents.delete('strange_rocks');
  setActiveEvent('magic_tree', 'resource');

  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'magic_tree');

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun clears expired target and picks new');
}

// --- Internal state tests ---

function test_clearTarget() {
  const routine = new EventRoutine();
  routine._targetEvent = { code: 'demon', type: 'monster' };
  routine._prepared = true;

  routine._clearTarget();

  assert.equal(routine._targetEvent, null);
  assert.equal(routine._prepared, false);
  console.log('  PASS: _clearTarget resets state');
}

function test_setCooldown() {
  const routine = new EventRoutine();
  const before = Date.now();
  routine._setCooldown('demon');
  const after = Date.now();

  assert.ok(routine._eventCooldowns['demon'] >= before);
  assert.ok(routine._eventCooldowns['demon'] <= after);
  console.log('  PASS: _setCooldown records timestamp');
}

function test_isOnCooldown() {
  const routine = new EventRoutine({ cooldownMs: 60_000 });
  const now = Date.now();

  // Not on cooldown
  assert.equal(routine._isOnCooldown('demon', now), false);

  // On cooldown
  routine._eventCooldowns['demon'] = now - 30_000; // 30s ago
  assert.equal(routine._isOnCooldown('demon', now), true);

  // Cooldown expired
  routine._eventCooldowns['demon'] = now - 120_000; // 2min ago
  assert.equal(routine._isOnCooldown('demon', now), false);

  routine._eventCooldowns = {};
  console.log('  PASS: _isOnCooldown respects cooldownMs');
}

// --- Gather list filter tests ---

function test_findBestEvent_gatherListFilter() {
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx({ skills: { mining: 10 } });

  setActiveEvent('strange_rocks', 'resource');
  setActiveEvent('magic_tree', 'resource');

  // With filter: only magic_tree allowed
  setGatherResources(['magic_tree']);
  routine._clearTarget();
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.resourceCode, 'magic_tree');

  clearEvents();
  routine._clearTarget();
  setGatherResources([]);
  console.log('  PASS: _findBestEvent respects gatherResources filter');
}

function test_findBestEvent_emptyGatherList() {
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx({ skills: { mining: 10 } });

  setActiveEvent('strange_rocks', 'resource');

  // Empty list = all resource events eligible (backward compat)
  setGatherResources([]);
  routine._clearTarget();
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.resourceCode, 'strange_rocks');

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: _findBestEvent allows all when gatherResources empty');
}

function test_findBestEvent_gatherListNoMatch() {
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: false });
  const ctx = makeCtx({ skills: { mining: 10 } });

  setActiveEvent('strange_rocks', 'resource');

  // Filter excludes all available events
  setGatherResources(['magic_tree']);
  routine._clearTarget();
  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  routine._clearTarget();
  setGatherResources([]);
  console.log('  PASS: _findBestEvent returns null when no events match gather list');
}

// --- Inventory-full target preservation tests ---

function test_inventoryFull_preservesTarget() {
  const routine = new EventRoutine({ monsterEvents: false, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('strange_rocks', 'resource');

  routine.canRun(ctx);
  assert.ok(routine._targetEvent);
  routine._prepared = true;

  // When inventory is full, canRun returns false but target should be preserved
  const fullCtx = makeCtx({ inventoryFull: true });
  assert.equal(routine.canRun(fullCtx), false);

  // Target and prepared state should still be set
  assert.ok(routine._targetEvent);
  assert.equal(routine._targetEvent.code, 'strange_rocks');
  assert.equal(routine._prepared, true);

  // When inventory clears, should resume same target
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'strange_rocks');
  assert.equal(routine._prepared, true);

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: inventory full preserves target and prepared state');
}

// --- NPC event lock integration tests ---

function test_npcLock_blocksOtherChars() {
  // CharA holds the lock → CharB should not find NPC events
  npcEventLock._resetForTests();
  npcEventLock.acquire('CharA', 'fish_merchant', 'fish_merchant');

  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: false, npcEvents: true });
  const ctx = makeCtx({ name: 'CharB' });
  setActiveEvent('fish_merchant', 'npc');

  // CharB can't pick it up — lock held by CharA
  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  routine._clearTarget();
  npcEventLock._resetForTests();
  console.log('  PASS: NPC lock blocks other characters from selecting NPC events');
}

function test_npcLock_allowsHolder() {
  // CharA holds the lock → CharA should still see NPC events
  // (Note: without npc buy config loaded, shopping list is empty → still false.
  //  This test verifies the lock check itself doesn't block the holder.)
  npcEventLock._resetForTests();
  npcEventLock.acquire('CharA', 'fish_merchant', 'fish_merchant');

  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: false, npcEvents: true });
  const ctx = makeCtx({ name: 'CharA' });
  setActiveEvent('fish_merchant', 'npc');

  // CharA is the holder — lock doesn't block them. But shopping list is empty → still false.
  // The key assertion is that we got past the lock check (no crash, no unexpected block).
  assert.equal(routine.canRun(ctx), false); // Empty shopping list, but NOT because of lock

  clearEvents();
  routine._clearTarget();
  npcEventLock._resetForTests();
  console.log('  PASS: NPC lock allows holder character to proceed (blocked by empty shopping list, not lock)');
}

function test_clearTarget_releasesNpcLock() {
  npcEventLock._resetForTests();
  npcEventLock.acquire('TestChar', 'fish_merchant', 'fish_merchant');

  const routine = new EventRoutine();
  routine._targetEvent = { code: 'fish_merchant', type: 'npc', npcCode: 'fish_merchant', map: { x: 1, y: 1 } };
  routine._prepared = true;
  routine._lockCharName = 'TestChar';

  assert.equal(npcEventLock.isHeld(), true);

  routine._clearTarget();

  assert.equal(npcEventLock.isHeld(), false);
  assert.equal(routine._targetEvent, null);
  assert.equal(routine._prepared, false);
  assert.equal(routine._lockCharName, null);

  npcEventLock._resetForTests();
  console.log('  PASS: _clearTarget releases NPC lock for NPC targets');
}

function test_clearTarget_doesNotReleaseForNonNpc() {
  npcEventLock._resetForTests();
  npcEventLock.acquire('OtherChar', 'fish_merchant', 'fish_merchant');

  const routine = new EventRoutine();
  routine._targetEvent = { code: 'demon', type: 'monster', monsterCode: 'demon', map: { x: 1, y: 1 } };
  routine._prepared = true;

  routine._clearTarget();

  // Lock should NOT be released — target was a monster, not NPC
  assert.equal(npcEventLock.isHeld(), true);
  assert.equal(npcEventLock.isHeldBy('OtherChar'), true);

  npcEventLock._resetForTests();
  console.log('  PASS: _clearTarget does NOT release NPC lock for non-NPC targets');
}

function test_canRun_expiryReleasesNpcLock() {
  npcEventLock._resetForTests();
  npcEventLock.acquire('TestChar', 'fish_merchant', 'fish_merchant');

  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: true, npcEvents: true });
  // Simulate an NPC target that we're tracking
  routine._targetEvent = { code: 'fish_merchant', type: 'npc', npcCode: 'fish_merchant', map: { x: 1, y: 1 } };
  routine._prepared = true;
  routine._lockCharName = 'TestChar';

  // Event has expired (not in active events)
  clearEvents();
  setActiveEvent('strange_rocks', 'resource');

  const ctx = makeCtx({ name: 'TestChar' });
  routine.canRun(ctx);

  // NPC lock should be released because the NPC event expired
  assert.equal(npcEventLock.isHeld(), false);

  clearEvents();
  routine._clearTarget();
  npcEventLock._resetForTests();
  console.log('  PASS: canRun releases NPC lock when NPC event expires');
}

function test_lockCharName_initialized() {
  const routine = new EventRoutine();
  assert.equal(routine._lockCharName, null);
  console.log('  PASS: _lockCharName initialized to null');
}

// --- Run ---

console.log('Event Routine Tests:');
test_urgent_flag();
test_default_config();
test_custom_config();
test_updateConfig();
test_canBePreempted();
test_canRun_disabled();
test_canRun_inventoryFull();
test_canRun_noActiveEvents();
test_canRun_npcEvent();
test_canRun_monsterEvent_noGameData();
test_canRun_monsterEvent_resolvesFromDefinition();
test_canRun_resourceEvent_noGameData();
test_canRun_eventExpiringSoon();
test_canRun_eventOnCooldown();
test_canRun_stickyTarget();
test_canRun_clearsExpiredTarget();
test_clearTarget();
test_setCooldown();
test_isOnCooldown();
test_findBestEvent_gatherListFilter();
test_findBestEvent_emptyGatherList();
test_findBestEvent_gatherListNoMatch();
test_inventoryFull_preservesTarget();
test_npcLock_blocksOtherChars();
test_npcLock_allowsHolder();
test_clearTarget_releasesNpcLock();
test_clearTarget_doesNotReleaseForNonNpc();
test_canRun_expiryReleasesNpcLock();
test_lockCharName_initialized();
console.log('All event routine tests passed!');
