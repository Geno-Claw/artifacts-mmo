#!/usr/bin/env node
/**
 * Tests for the Event Manager service.
 */
import assert from 'node:assert/strict';

// --- Mock websocket-client before importing event-manager ---
let subscribedHandlers = {};
const mockSubscribe = (type, handler) => {
  subscribedHandlers[type] = handler;
  return () => { delete subscribedHandlers[type]; };
};

// Mock modules
const origModules = {};

async function setup() {
  // We'll test the internal handlers directly via exported test helpers
}

// --- Import the module under test ---
import {
  initialize,
  cleanup,
  getActiveMonsterEvents,
  getActiveResourceEvents,
  getActiveNpcEvents,
  isEventActive,
  getTimeRemaining,
  getEventDefinition,
  getActiveEvent,
  _handleEventSpawn,
  _handleEventRemoved,
  _activeEvents,
  _eventDefinitions,
} from '../src/services/event-manager.mjs';

// --- Tests ---

function test_handleEventSpawn_addsEvent() {
  _activeEvents.clear();

  _handleEventSpawn({
    map: { x: 5, y: 10, content: { type: 'monster', code: 'demon' } },
    expiration: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  });

  assert.equal(_activeEvents.size, 1);
  const entry = _activeEvents.get('demon');
  assert.ok(entry);
  assert.equal(entry.contentType, 'monster');
  assert.equal(entry.contentCode, 'demon');
  assert.equal(entry.map.x, 5);
  assert.equal(entry.map.y, 10);
  assert.ok(entry.expiration instanceof Date);

  _activeEvents.clear();
  console.log('  PASS: handleEventSpawn adds event');
}

function test_handleEventSpawn_ignoresMissingContent() {
  _activeEvents.clear();

  _handleEventSpawn({ map: { x: 1, y: 1, content: {} } });
  assert.equal(_activeEvents.size, 0);

  _handleEventSpawn(null);
  assert.equal(_activeEvents.size, 0);

  console.log('  PASS: handleEventSpawn ignores missing content');
}

function test_handleEventRemoved_removesEvent() {
  _activeEvents.clear();
  _activeEvents.set('demon', { code: 'demon', contentType: 'monster' });

  _handleEventRemoved({
    map: { content: { code: 'demon' } },
  });

  assert.equal(_activeEvents.size, 0);
  console.log('  PASS: handleEventRemoved removes event');
}

function test_handleEventRemoved_noop() {
  _activeEvents.clear();

  _handleEventRemoved({
    map: { content: { code: 'nonexistent' } },
  });

  assert.equal(_activeEvents.size, 0);
  console.log('  PASS: handleEventRemoved noop for unknown code');
}

function test_isEventActive_valid() {
  _activeEvents.clear();
  _activeEvents.set('demon', {
    code: 'demon',
    expiration: new Date(Date.now() + 120_000), // 2 min from now
  });

  assert.equal(isEventActive('demon'), true);
  assert.equal(isEventActive('nonexistent'), false);

  _activeEvents.clear();
  console.log('  PASS: isEventActive with valid event');
}

function test_isEventActive_expired() {
  _activeEvents.clear();
  _activeEvents.set('demon', {
    code: 'demon',
    expiration: new Date(Date.now() + 10_000), // 10s from now — within 30s buffer
  });

  assert.equal(isEventActive('demon'), false);

  _activeEvents.clear();
  console.log('  PASS: isEventActive returns false within expiry buffer');
}

function test_getTimeRemaining() {
  _activeEvents.clear();
  const futureMs = Date.now() + 60_000;
  _activeEvents.set('demon', {
    code: 'demon',
    expiration: new Date(futureMs),
  });

  const remaining = getTimeRemaining('demon');
  assert.ok(remaining > 59_000 && remaining <= 60_000);

  assert.equal(getTimeRemaining('nonexistent'), 0);

  _activeEvents.clear();
  console.log('  PASS: getTimeRemaining returns correct ms');
}

function test_getActiveMonsterEvents_filters() {
  _activeEvents.clear();

  _activeEvents.set('demon', {
    code: 'demon',
    contentType: 'monster',
    contentCode: 'demon',
    map: { x: 1, y: 1 },
    expiration: new Date(Date.now() + 120_000),
  });

  _activeEvents.set('strange_rocks', {
    code: 'strange_rocks',
    contentType: 'resource',
    contentCode: 'strange_rocks',
    map: { x: 2, y: 2 },
    expiration: new Date(Date.now() + 120_000),
  });

  _activeEvents.set('fish_merchant', {
    code: 'fish_merchant',
    contentType: 'npc',
    contentCode: 'fish_merchant',
    map: { x: 3, y: 3 },
    expiration: new Date(Date.now() + 120_000),
  });

  // Expired monster — should be filtered out
  _activeEvents.set('bandit_lizard', {
    code: 'bandit_lizard',
    contentType: 'monster',
    contentCode: 'bandit_lizard',
    map: { x: 4, y: 4 },
    expiration: new Date(Date.now() + 5_000), // Within buffer
  });

  const monsters = getActiveMonsterEvents();
  assert.equal(monsters.length, 1);
  assert.equal(monsters[0].code, 'demon');

  const resources = getActiveResourceEvents();
  assert.equal(resources.length, 1);
  assert.equal(resources[0].code, 'strange_rocks');

  const npcs = getActiveNpcEvents();
  assert.equal(npcs.length, 1);
  assert.equal(npcs[0].code, 'fish_merchant');

  _activeEvents.clear();
  console.log('  PASS: getActiveMonsterEvents/Resource/Npc filters correctly');
}

function test_getEventDefinition() {
  _eventDefinitions.clear();
  _eventDefinitions.set('demon', { code: 'demon', name: 'Portal (Demon)', content: { type: 'monster', code: 'demon' } });

  const def = getEventDefinition('demon');
  assert.ok(def);
  assert.equal(def.code, 'demon');

  assert.equal(getEventDefinition('nonexistent'), null);

  _eventDefinitions.clear();
  console.log('  PASS: getEventDefinition returns correct data');
}

function test_cleanup_clearsState() {
  _activeEvents.set('demon', { code: 'demon' });
  _eventDefinitions.set('demon', { code: 'demon' });

  cleanup();

  assert.equal(_activeEvents.size, 0);
  assert.equal(_eventDefinitions.size, 0);
  console.log('  PASS: cleanup clears all state');
}

// --- Run ---

console.log('Event Manager Tests:');
test_handleEventSpawn_addsEvent();
test_handleEventSpawn_ignoresMissingContent();
test_handleEventRemoved_removesEvent();
test_handleEventRemoved_noop();
test_isEventActive_valid();
test_isEventActive_expired();
test_getTimeRemaining();
test_getActiveMonsterEvents_filters();
test_getEventDefinition();
test_cleanup_clearsState();
console.log('All event manager tests passed!');
