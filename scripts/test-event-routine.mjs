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
import { _activeEvents, _eventDefinitions } from '../src/services/event-manager.mjs';

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
  // NPC events don't need gameData lookups, so they work without cache
  const routine = new EventRoutine({ monsterEvents: false, resourceEvents: false, npcEvents: true });
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc');

  assert.equal(routine.canRun(ctx), true);
  assert.ok(routine._targetEvent);
  assert.equal(routine._targetEvent.type, 'npc');
  assert.equal(routine._targetEvent.code, 'fish_merchant');

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun finds NPC event (no game data needed)');
}

function test_canRun_monsterEvent_noGameData() {
  // Without game-data cache, getMonster returns null → monster events skipped
  const routine = new EventRoutine({ resourceEvents: false, npcEvents: false });
  const ctx = makeCtx();
  setActiveEvent('demon', 'monster');

  // getMonster('demon') returns null (cache not initialized) → skipped
  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  console.log('  PASS: canRun skips monster events when game data unavailable');
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
  const routine = new EventRoutine({ minTimeRemainingMs: 120_000, monsterEvents: false, npcEvents: true });
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc', { expiresInMs: 60_000 }); // 1 min left < 2 min min

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  console.log('  PASS: canRun skips event expiring soon');
}

function test_canRun_eventOnCooldown() {
  const routine = new EventRoutine({ cooldownMs: 60_000, monsterEvents: false, npcEvents: true });
  routine._eventCooldowns['fish_merchant'] = Date.now();
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc');

  assert.equal(routine.canRun(ctx), false);

  clearEvents();
  routine._eventCooldowns = {};
  console.log('  PASS: canRun skips event on cooldown');
}

function test_canRun_stickyTarget() {
  const routine = new EventRoutine({ monsterEvents: false, npcEvents: true });
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc');

  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'fish_merchant');

  // Another NPC appears — shouldn't switch
  setActiveEvent('gemstone_merchant', 'npc');
  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'fish_merchant'); // Still sticky

  clearEvents();
  routine._clearTarget();
  console.log('  PASS: canRun sticks to current target while active');
}

function test_canRun_clearsExpiredTarget() {
  const routine = new EventRoutine({ monsterEvents: false, npcEvents: true });
  const ctx = makeCtx();
  setActiveEvent('fish_merchant', 'npc');

  routine.canRun(ctx);
  assert.equal(routine._targetEvent.code, 'fish_merchant');

  // Remove the event
  _activeEvents.delete('fish_merchant');
  setActiveEvent('gemstone_merchant', 'npc');

  assert.equal(routine.canRun(ctx), true);
  assert.equal(routine._targetEvent.code, 'gemstone_merchant');

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
test_canRun_resourceEvent_noGameData();
test_canRun_eventExpiringSoon();
test_canRun_eventOnCooldown();
test_canRun_stickyTarget();
test_canRun_clearsExpiredTarget();
test_clearTarget();
test_setCooldown();
test_isOnCooldown();
console.log('All event routine tests passed!');
