#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  _resetUiStateForTests,
  getUiSnapshot,
  initializeUiState,
  recordCharacterSnapshot,
  recordCooldown,
  recordLog,
  recordRoutineState,
} from '../src/services/ui-state.mjs';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChar(snapshot, name) {
  return snapshot.characters.find(c => c.name === name);
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

  console.log('test-ui-state: PASS');
}

await run();
