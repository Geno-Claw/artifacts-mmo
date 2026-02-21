#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as uiState from '../src/services/ui-state.mjs';

const {
  _resetUiStateForTests,
  getUiSnapshot,
  initializeUiState,
  recordCharacterSnapshot,
  recordCooldown,
  recordLog,
  recordRoutineState,
} = uiState;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChar(snapshot, name) {
  return snapshot.characters.find(c => c.name === name);
}

function assertHasKeys(obj, keys, label) {
  assert.ok(obj && typeof obj === 'object', `${label} must be an object`);
  for (const key of keys) {
    assert.equal(Object.hasOwn(obj, key), true, `${label} missing key "${key}"`);
  }
}

function resolveDetailGetter() {
  const priorityNames = [
    'getUiCharacterDetail',
    'getCharacterDetail',
    'getUiCharacter',
    'getUiCharacterState',
    'getUiCharacterSnapshot',
  ];

  for (const name of priorityNames) {
    if (typeof uiState[name] === 'function') return uiState[name];
  }

  for (const [name, fn] of Object.entries(uiState)) {
    if (typeof fn !== 'function') continue;
    if (!name.startsWith('get')) continue;
    if (!/character/i.test(name)) continue;
    if (!/(detail|state|snapshot)/i.test(name)) continue;
    return fn;
  }

  const exportedGetters = Object.keys(uiState)
    .filter(key => key.startsWith('get'))
    .sort()
    .join(', ');

  assert.fail(`No character detail getter export found in ui-state module. get* exports: [${exportedGetters}]`);
}

async function getDetailPayload(getter, name) {
  try {
    const result = getter(name);
    return result && typeof result.then === 'function' ? await result : result;
  } catch (err) {
    const result = getter({ name });
    return result && typeof result.then === 'function' ? await result : result;
  }
}

function assertDetailShape(detail, expectedName) {
  assertHasKeys(detail, [
    'identity',
    'skills',
    'inventory',
    'equipment',
    'stats',
    'logHistory',
    'updatedAtMs',
  ], 'detail payload');

  assertHasKeys(detail.identity, ['name', 'status', 'stale', 'level'], 'detail.identity');
  assert.equal(detail.identity.name, expectedName);
  assert.equal(typeof detail.identity.status, 'string');
  assert.equal(typeof detail.identity.stale, 'boolean');
  assert.equal(typeof detail.identity.level, 'number');

  assert.ok(Array.isArray(detail.skills), 'detail.skills must be an array');
  assert.ok(Array.isArray(detail.inventory), 'detail.inventory must be an array');
  assert.ok(Array.isArray(detail.equipment), 'detail.equipment must be an array');
  assert.ok(Array.isArray(detail.logHistory), 'detail.logHistory must be an array');

  for (const [idx, skill] of detail.skills.entries()) {
    assertHasKeys(skill, ['code', 'level', 'xp', 'maxXp', 'pct'], `detail.skills[${idx}]`);
    assert.equal(typeof skill.code, 'string');
    assert.equal(typeof skill.level, 'number');
    assert.equal(typeof skill.xp, 'number');
    assert.equal(typeof skill.maxXp, 'number');
    assert.equal(typeof skill.pct, 'number');
  }

  for (const [idx, item] of detail.inventory.entries()) {
    assertHasKeys(item, ['code', 'quantity', 'slotIndex'], `detail.inventory[${idx}]`);
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.quantity, 'number');
    assert.equal(typeof item.slotIndex, 'number');
  }

  for (const [idx, item] of detail.equipment.entries()) {
    assertHasKeys(item, ['slot', 'code', 'quantity'], `detail.equipment[${idx}]`);
    assert.equal(typeof item.slot, 'string');
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.quantity, 'number');
  }

  assertHasKeys(detail.stats, ['hp', 'maxHp', 'xp', 'maxXp', 'gold', 'position'], 'detail.stats');
  assertHasKeys(detail.stats.position, ['x', 'y', 'layer'], 'detail.stats.position');
  assert.equal(typeof detail.updatedAtMs, 'number');
}

async function run() {
  _resetUiStateForTests();

  initializeUiState({
    characterNames: ['Alpha', 'Beta'],
    configPath: './config/characters-local.json',
    startedAt: 123,
    staleAfterMs: 10,
    logLimit: 20,
  });

  const initSnap = getUiSnapshot();
  assert.equal(initSnap.configPath, './config/characters-local.json');
  assert.equal(initSnap.startedAtMs, 123);
  assert.equal(initSnap.characters.length, 2);

  const alphaInit = getChar(initSnap, 'Alpha');
  assert.equal(alphaInit.status, 'starting');
  assert.equal(alphaInit.stale, true);
  assert.equal(alphaInit.logHistory.length, 0);

  recordCharacterSnapshot('Alpha', {
    level: 12,
    hp: 140,
    max_hp: 200,
    xp: 5600,
    max_xp: 8000,
    x: 3,
    y: 9,
    layer: 'overworld',
    task: 'chicken',
    task_type: 'monsters',
    task_progress: 17,
    task_total: 50,
  });

  const afterChar = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterChar.status, 'running');
  assert.equal(afterChar.stale, false);
  assert.equal(afterChar.level, 12);
  assert.equal(afterChar.hp, 140);
  assert.equal(afterChar.maxHp, 200);
  assert.equal(afterChar.xp, 5600);
  assert.equal(afterChar.maxXp, 8000);
  assert.equal(afterChar.position.x, 3);
  assert.equal(afterChar.position.y, 9);
  assert.equal(afterChar.position.layer, 'overworld');
  assert.equal(afterChar.task.label, 'chicken (17/50)');

  recordCooldown('Alpha', {
    action: 'fight',
    totalSeconds: 10,
    remainingSeconds: 4,
    observedAt: 1_000,
  });

  const afterCd = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterCd.cooldown.action, 'fight');
  assert.equal(afterCd.cooldown.totalSeconds, 10);
  assert.equal(afterCd.cooldown.endsAtMs, 5_000);

  recordRoutineState('Alpha', {
    routineName: 'Skill Rotation',
    phase: 'start',
    priority: 5,
  });

  let afterRoutine = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterRoutine.routine.name, 'Skill Rotation');
  assert.equal(afterRoutine.routine.phase, 'start');
  assert.equal(afterRoutine.routine.priority, 5);

  recordRoutineState('Alpha', {
    routineName: 'Skill Rotation',
    phase: 'error',
    priority: 5,
    error: 'boom',
  });

  afterRoutine = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterRoutine.status, 'error');
  assert.equal(afterRoutine.routine.phase, 'error');
  assert.equal(afterRoutine.routine.error, 'boom');

  recordCharacterSnapshot('Alpha', {
    level: 13,
    hp: 170,
    max_hp: 200,
    xp: 100,
    max_xp: 1000,
  });

  afterRoutine = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterRoutine.status, 'running');
  assert.equal(afterRoutine.routine.phase, 'idle');
  assert.equal(afterRoutine.routine.error, '');

  for (let i = 0; i < 25; i++) {
    recordLog('Alpha', {
      level: 'info',
      line: `line-${i}`,
      at: i,
    });
  }

  const afterLogs = getChar(getUiSnapshot(), 'Alpha');
  assert.equal(afterLogs.logHistory.length, 20);
  assert.equal(afterLogs.logHistory[0].line, 'line-5');
  assert.equal(afterLogs.logLatest, 'line-24');

  recordCharacterSnapshot('Beta', {
    level: 1,
    hp: 10,
    max_hp: 10,
    xp: 0,
    max_xp: 100,
  });

  await wait(20);

  const staleSnap = getUiSnapshot();
  const betaStale = getChar(staleSnap, 'Beta');
  assert.equal(betaStale.stale, true);

  // Phase 2 detail normalization checks.
  _resetUiStateForTests();
  initializeUiState({
    characterNames: ['Gamma'],
    configPath: './config/characters-local.json',
    startedAt: 999,
    staleAfterMs: 60_000,
    logLimit: 120,
  });

  recordCharacterSnapshot('Gamma', {
    level: 22,
    hp: 330,
    max_hp: 500,
    xp: 7800,
    max_xp: 10000,
    x: 11,
    y: 27,
    layer: 'overworld',
    gold: 12345,
    task: 'wolf',
    task_type: 'monsters',
    task_progress: 4,
    task_total: 20,
    mining_level: 12,
    mining_xp: 640,
    mining_max_xp: 1000,
    woodcutting_level: 9,
    woodcutting_xp: 400,
    woodcutting_max_xp: 800,
    fishing_level: 5,
    fishing_xp: 150,
    fishing_max_xp: 450,
    weaponcrafting_level: 3,
    weaponcrafting_xp: 120,
    weaponcrafting_max_xp: 300,
    inventory: [
      { slot: 1, code: 'copper_ore', quantity: 22 },
      { slot: 2, code: 'spruce_log', quantity: 8 },
      { slot: 3, code: null, quantity: 0 },
    ],
    weapon_slot: 'copper_sword',
    weapon_slot_quantity: 1,
    shield_slot: 'wooden_shield',
    shield_slot_quantity: 1,
    ring1_slot: 'topaz_ring',
    ring1_slot_quantity: 1,
  });

  for (let i = 0; i < 75; i++) {
    recordLog('Gamma', {
      level: 'info',
      line: `detail-history-${i}`,
      at: i,
    });
  }

  const detailGetter = resolveDetailGetter();
  const detail = await getDetailPayload(detailGetter, 'Gamma');
  assertDetailShape(detail, 'Gamma');
  assert.equal(detail.skills.some(skill => skill.code === 'mining'), true);
  assert.equal(detail.inventory.some(item => item.code === 'copper_ore'), true);
  assert.equal(detail.equipment.some(item => item.slot === 'weapon'), true);
  assert.equal(detail.logHistory.length, 50, 'detail.logHistory should be capped at 50 entries');
  assert.equal(detail.logHistory.some(entry => entry.line === 'detail-history-74'), true);
  assert.equal(detail.logHistory.some(entry => entry.line === 'detail-history-0'), false);

  // --- Cooldown extraction from character snapshot ---

  _resetUiStateForTests();
  initializeUiState({ characterNames: ['CdChar'], staleAfterMs: 60_000 });

  // Future cooldown_expiration sets cooldown.endsAtMs
  {
    const futureMs = Date.now() + 15_000;
    recordCharacterSnapshot('CdChar', {
      level: 5, hp: 50, max_hp: 100, xp: 0, max_xp: 100,
      cooldown: 15,
      cooldown_expiration: new Date(futureMs).toISOString(),
    });
    const snap = getChar(getUiSnapshot(), 'CdChar');
    assert.ok(snap.cooldown.endsAtMs > Date.now(), 'endsAtMs should be in the future');
    assert.equal(snap.cooldown.totalSeconds, 15);
  }

  // Past cooldown_expiration does NOT update cooldown
  {
    _resetUiStateForTests();
    initializeUiState({ characterNames: ['CdChar'], staleAfterMs: 60_000 });
    recordCharacterSnapshot('CdChar', {
      level: 5, hp: 50, max_hp: 100, xp: 0, max_xp: 100,
      cooldown: 0,
      cooldown_expiration: new Date(Date.now() - 5000).toISOString(),
    });
    const snap = getChar(getUiSnapshot(), 'CdChar');
    assert.equal(snap.cooldown.endsAtMs, 0, 'past expiration should not set endsAtMs');
  }

  // Missing cooldown_expiration is harmless
  {
    _resetUiStateForTests();
    initializeUiState({ characterNames: ['CdChar'], staleAfterMs: 60_000 });
    recordCharacterSnapshot('CdChar', {
      level: 5, hp: 50, max_hp: 100, xp: 0, max_xp: 100,
    });
    const snap = getChar(getUiSnapshot(), 'CdChar');
    assert.equal(snap.cooldown.endsAtMs, 0, 'missing expiration should leave default');
  }

  // Invalid cooldown_expiration is harmless
  {
    _resetUiStateForTests();
    initializeUiState({ characterNames: ['CdChar'], staleAfterMs: 60_000 });
    recordCharacterSnapshot('CdChar', {
      level: 5, hp: 50, max_hp: 100, xp: 0, max_xp: 100,
      cooldown_expiration: 'not-a-date',
    });
    const snap = getChar(getUiSnapshot(), 'CdChar');
    assert.equal(snap.cooldown.endsAtMs, 0, 'invalid expiration should leave default');
  }

  // recordCooldown with later expiration is NOT clobbered by earlier snapshot
  {
    _resetUiStateForTests();
    initializeUiState({ characterNames: ['CdChar'], staleAfterMs: 60_000 });

    recordCooldown('CdChar', {
      action: 'fight',
      totalSeconds: 30,
      remainingSeconds: 30,
      observedAt: Date.now(),
    });
    const afterCd = getChar(getUiSnapshot(), 'CdChar');
    const laterEndsAt = afterCd.cooldown.endsAtMs;

    // Snapshot with an earlier expiration should not overwrite
    const earlierMs = Date.now() + 10_000;
    recordCharacterSnapshot('CdChar', {
      level: 5, hp: 50, max_hp: 100, xp: 0, max_xp: 100,
      cooldown: 10,
      cooldown_expiration: new Date(earlierMs).toISOString(),
    });
    const snap = getChar(getUiSnapshot(), 'CdChar');
    assert.ok(snap.cooldown.endsAtMs >= laterEndsAt - 100, 'should not clobber later cooldown');
    assert.equal(snap.cooldown.action, 'fight', 'should preserve action from recordCooldown');
  }

  console.log('test-ui-state: PASS');
}

await run();
