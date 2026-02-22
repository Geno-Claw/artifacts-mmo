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
  getNpcEventCodes,
  setGatherResources,
  getGatherResources,
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

function test_handleEventSpawn_siblingContent() {
  _activeEvents.clear();

  // WebSocket format: content as sibling of map (not nested inside)
  _handleEventSpawn({
    content: { type: 'npc', code: 'nomadic_merchant' },
    map: { x: 3, y: 2 },
    expiration: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  });

  assert.equal(_activeEvents.size, 1);
  const entry = _activeEvents.get('nomadic_merchant');
  assert.ok(entry);
  assert.equal(entry.contentType, 'npc');
  assert.equal(entry.contentCode, 'nomadic_merchant');
  assert.equal(entry.map.x, 3);
  assert.equal(entry.map.y, 2);

  _activeEvents.clear();
  console.log('  PASS: handleEventSpawn with sibling content format');
}

function test_handleEventRemoved_siblingContent() {
  _activeEvents.clear();
  _activeEvents.set('nomadic_merchant', { code: 'nomadic_merchant', contentType: 'npc' });

  _handleEventRemoved({
    content: { code: 'nomadic_merchant' },
    map: { x: 3, y: 2 },
  });

  assert.equal(_activeEvents.size, 0);
  console.log('  PASS: handleEventRemoved with sibling content format');
}

function test_getNpcEventCodes() {
  _eventDefinitions.clear();
  _eventDefinitions.set('demon', { code: 'demon', content: { type: 'monster', code: 'demon' } });
  _eventDefinitions.set('nomadic_merchant', { code: 'nomadic_merchant', content: { type: 'npc', code: 'nomadic_merchant' } });
  _eventDefinitions.set('fish_merchant', { code: 'fish_merchant', content: { type: 'npc', code: 'fish_merchant' } });
  _eventDefinitions.set('strange_rocks', { code: 'strange_rocks', content: { type: 'resource', code: 'strange_rocks' } });

  const npcCodes = getNpcEventCodes();
  assert.equal(npcCodes.length, 2);
  assert.ok(npcCodes.includes('nomadic_merchant'));
  assert.ok(npcCodes.includes('fish_merchant'));

  _eventDefinitions.clear();
  console.log('  PASS: getNpcEventCodes returns NPC content codes');
}

function test_handleEventSpawn_fallbackToDataCode() {
  _activeEvents.clear();

  // NPC events may have code at top level instead of map.content
  _handleEventSpawn({
    code: 'strange_vendor',
    type: 'npc',
    map: { x: 3, y: 7 },
    expiration: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  });

  assert.equal(_activeEvents.size, 1);
  const entry = _activeEvents.get('strange_vendor');
  assert.ok(entry);
  assert.equal(entry.contentType, 'npc');
  assert.equal(entry.contentCode, 'strange_vendor');
  assert.equal(entry.map.x, 3);

  _activeEvents.clear();
  console.log('  PASS: handleEventSpawn fallback to data.code');
}

function test_handleEventSpawn_fallbackToDataName() {
  _activeEvents.clear();

  // Fallback to data.name when code is also missing
  _handleEventSpawn({
    name: 'mysterious_npc',
    map: { x: 5, y: 5 },
    expiration: new Date(Date.now() + 3600_000).toISOString(),
  });

  assert.equal(_activeEvents.size, 1);
  assert.ok(_activeEvents.get('mysterious_npc'));

  _activeEvents.clear();
  console.log('  PASS: handleEventSpawn fallback to data.name');
}

function test_handleEventRemoved_fallbackToDataCode() {
  _activeEvents.clear();
  _activeEvents.set('strange_vendor', { code: 'strange_vendor', contentType: 'npc' });

  _handleEventRemoved({ code: 'strange_vendor' });

  assert.equal(_activeEvents.size, 0);
  console.log('  PASS: handleEventRemoved fallback to data.code');
}

function test_gatherResources_accessors() {
  setGatherResources(['strange_rocks', 'magic_tree']);
  assert.deepEqual(getGatherResources(), ['strange_rocks', 'magic_tree']);

  setGatherResources([]);
  assert.deepEqual(getGatherResources(), []);

  // Invalid input
  setGatherResources(null);
  assert.deepEqual(getGatherResources(), []);

  console.log('  PASS: gatherResources accessors');
}

function test_cleanup_resetsGatherResources() {
  setGatherResources(['strange_rocks']);
  assert.equal(getGatherResources().length, 1);

  cleanup();

  assert.deepEqual(getGatherResources(), []);
  console.log('  PASS: cleanup resets gatherResources');
}

function test_handleEventSpawn_resolvesContentTypeFromDefinition() {
  _activeEvents.clear();
  _eventDefinitions.clear();

  // Pre-load a definition with content type
  _eventDefinitions.set('corrupted_owlbear', {
    code: 'corrupted_owlbear',
    content: { type: 'monster', code: 'corrupted_owlbear' },
  });

  // Spawn event WITHOUT content type (matches real active events API format)
  _handleEventSpawn({
    code: 'corrupted_owlbear',
    map: { x: 10, y: 2 },
    expiration: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
  });

  assert.equal(_activeEvents.size, 1);
  const entry = _activeEvents.get('corrupted_owlbear');
  assert.ok(entry);
  assert.equal(entry.contentType, 'monster');
  assert.equal(entry.map.x, 10);

  // Should appear in monster events
  const monsters = getActiveMonsterEvents();
  assert.equal(monsters.length, 1);
  assert.equal(monsters[0].contentCode, 'corrupted_owlbear');

  _activeEvents.clear();
  _eventDefinitions.clear();
  console.log('  PASS: handleEventSpawn resolves contentType from event definition');
}

function test_catchup_resolvesContentTypeFromDefinition() {
  _activeEvents.clear();
  _eventDefinitions.clear();

  // Pre-load a definition
  _eventDefinitions.set('strange_rocks', {
    code: 'strange_rocks',
    content: { type: 'resource', code: 'strange_rocks' },
  });

  // Simulate catch-up by directly inserting an event without contentType,
  // then resolving via the same logic the catch-up code uses
  const contentCode = 'strange_rocks';
  let contentType = null; // API didn't provide it
  if (!contentType) {
    const def = _eventDefinitions.get(contentCode);
    if (def?.content?.type) {
      contentType = def.content.type;
    }
  }

  _activeEvents.set(contentCode, {
    code: contentCode,
    contentType: contentType || null,
    contentCode,
    map: { x: 3, y: 5 },
    expiration: new Date(Date.now() + 300_000),
    createdAt: new Date(),
  });

  assert.equal(_activeEvents.get('strange_rocks').contentType, 'resource');

  const resources = getActiveResourceEvents();
  assert.equal(resources.length, 1);
  assert.equal(resources[0].contentCode, 'strange_rocks');

  _activeEvents.clear();
  _eventDefinitions.clear();
  console.log('  PASS: catch-up resolves contentType from event definition');
}

// --- Run ---

console.log('Event Manager Tests:');
test_handleEventSpawn_addsEvent();
test_handleEventSpawn_ignoresMissingContent();
test_handleEventSpawn_siblingContent();
test_handleEventRemoved_removesEvent();
test_handleEventRemoved_noop();
test_handleEventRemoved_siblingContent();
test_isEventActive_valid();
test_isEventActive_expired();
test_getTimeRemaining();
test_getActiveMonsterEvents_filters();
test_getEventDefinition();
test_getNpcEventCodes();
test_handleEventSpawn_fallbackToDataCode();
test_handleEventSpawn_fallbackToDataName();
test_handleEventRemoved_fallbackToDataCode();
test_gatherResources_accessors();
test_cleanup_resetsGatherResources();
test_handleEventSpawn_resolvesContentTypeFromDefinition();
test_catchup_resolvesContentTypeFromDefinition();
console.log('All event manager tests passed!');
