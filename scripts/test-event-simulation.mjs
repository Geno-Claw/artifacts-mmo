#!/usr/bin/env node
/**
 * Tests for the Event Simulation service.
 */
import assert from 'node:assert/strict';
import { buildFakeCharacter, canCharacterBeatEvent, clearCache, _simCache } from '../src/services/event-simulation.mjs';
import {
  _resetForTests as resetCombatConfigForTests,
  loadCombatConfig,
} from '../src/services/combat-config.mjs';

const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor', 'leg_armor', 'boots',
  'ring1', 'ring2', 'amulet', 'artifact1', 'artifact2', 'artifact3',
  'utility1', 'utility2', 'rune',
];

// --- Fake CharacterContext ---

function makeCtx(overrides = {}) {
  const char = {
    name: 'TestChar',
    level: 30,
    weapon_slot: 'iron_sword',
    shield_slot: 'iron_shield',
    helmet_slot: null,
    body_armor_slot: 'iron_armor',
    leg_armor_slot: 'iron_legs',
    boots_slot: 'iron_boots',
    ring1_slot: null,
    ring2_slot: null,
    amulet_slot: null,
    artifact1_slot: null,
    artifact2_slot: null,
    artifact3_slot: null,
    utility1_slot: 'small_health_potion',
    utility1_slot_quantity: 5,
    utility2_slot: null,
    utility2_slot_quantity: 1,
    rune_slot: null,
    ...overrides,
  };
  return {
    name: char.name,
    get() { return char; },
    skillLevel(skill) { return char[`${skill}_level`] || 0; },
  };
}

function cacheKeyForTest(ctx, monsterCode) {
  const char = ctx.get();
  const equipCodes = EQUIPMENT_SLOTS.map(slot => char[`${slot}_slot`] || '').join(':');
  return `${ctx.name}:${monsterCode}:${char.level}:${equipCodes}`;
}

// --- Tests ---

function test_buildFakeCharacter_basic() {
  const ctx = makeCtx();
  const fake = buildFakeCharacter(ctx);

  assert.equal(fake.level, 30);
  assert.equal(fake.weapon_slot, 'iron_sword');
  assert.equal(fake.shield_slot, 'iron_shield');
  assert.equal(fake.body_armor_slot, 'iron_armor');
  assert.equal(fake.utility1_slot, 'small_health_potion');
  assert.equal(fake.utility1_slot_quantity, 5);
  // Null slots should not appear in the object
  assert.equal(fake.helmet_slot, undefined);
  assert.equal(fake.ring1_slot, undefined);
  assert.equal(fake.rune_slot, undefined);

  console.log('  PASS: buildFakeCharacter basic');
}

function test_buildFakeCharacter_empty() {
  const ctx = makeCtx({
    weapon_slot: null,
    shield_slot: null,
    body_armor_slot: null,
    leg_armor_slot: null,
    boots_slot: null,
    utility1_slot: null,
    utility2_slot: null,
  });
  const fake = buildFakeCharacter(ctx);

  assert.equal(fake.level, 30);
  // Only level should be present
  const keys = Object.keys(fake);
  assert.equal(keys.length, 1);
  assert.ok(keys.includes('level'));

  console.log('  PASS: buildFakeCharacter with no equipment');
}

function test_clearCache_all() {
  _simCache.set('TestChar:demon:30:iron_sword', { result: {}, cachedAt: Date.now() });
  _simCache.set('OtherChar:demon:25:steel_sword', { result: {}, cachedAt: Date.now() });

  clearCache();
  assert.equal(_simCache.size, 0);

  console.log('  PASS: clearCache all');
}

function test_clearCache_byCharacter() {
  _simCache.set('TestChar:demon:30:iron_sword', { result: {}, cachedAt: Date.now() });
  _simCache.set('OtherChar:demon:25:steel_sword', { result: {}, cachedAt: Date.now() });

  clearCache('TestChar');
  assert.equal(_simCache.size, 1);
  assert.ok(_simCache.has('OtherChar:demon:25:steel_sword'));

  _simCache.clear();
  console.log('  PASS: clearCache by character name');
}

async function test_cachedResultsUseCurrentThreshold() {
  const ctx = makeCtx();
  const key = cacheKeyForTest(ctx, 'demon');
  _simCache.set(key, {
    summary: {
      winrate: 85,
      avgTurns: 7,
      source: 'api',
    },
    cachedAt: Date.now(),
  });

  loadCombatConfig({ combat: { winRateThreshold: 90 } });
  const strictResult = await canCharacterBeatEvent(ctx, 'demon');
  assert.equal(strictResult.canWin, false);
  assert.equal(strictResult.threshold, 90);
  assert.equal(strictResult.winrate, 85);

  loadCombatConfig({ combat: { winRateThreshold: 80 } });
  const relaxedResult = await canCharacterBeatEvent(ctx, 'demon');
  assert.equal(relaxedResult.canWin, true);
  assert.equal(relaxedResult.threshold, 80);
  assert.equal(relaxedResult.winrate, 85);
  assert.equal(relaxedResult.avgTurns, 7);
  assert.equal(relaxedResult.source, 'api');

  clearCache();
  resetCombatConfigForTests();
  console.log('  PASS: cached results re-evaluate against current threshold');
}

// --- Run ---

console.log('Event Simulation Tests:');
test_buildFakeCharacter_basic();
test_buildFakeCharacter_empty();
test_clearCache_all();
test_clearCache_byCharacter();
await test_cachedResultsUseCurrentThreshold();
console.log('All event simulation tests passed!');
