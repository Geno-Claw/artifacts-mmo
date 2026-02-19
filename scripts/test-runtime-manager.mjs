#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeOperationConflictError,
  createRuntimeManager,
} from '../src/runtime-manager.mjs';
import {
  _resetOrderBoardForTests,
  claimOrder,
  createOrMergeOrder,
  getOrderBoardSnapshot,
  initializeOrderBoard,
} from '../src/services/order-board.mjs';
import {
  _resetGearStateForTests,
  _setDepsForTests as setGearStateDepsForTests,
  getCharacterGearState,
  initializeGearState,
  refreshGearState,
  registerContext,
} from '../src/services/gear-state.mjs';

const VALID_LIFECYCLE_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);

function createDeferred() {
  let resolveFn = () => {};
  let rejectFn = () => {};
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, {
  timeoutMs = 1_000,
  intervalMs = 10,
  label = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() <= deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }

    await sleep(intervalMs);
  }

  if (lastErr) {
    throw new Error(`Timed out waiting for ${label}: ${lastErr.message}`);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assertStatusShape(status, label = 'runtime status') {
  assert.ok(status && typeof status === 'object', `${label} must be an object`);
  assert.equal(typeof status.state, 'string', `${label}.state must be a string`);
  assert.equal(
    VALID_LIFECYCLE_STATES.has(status.state),
    true,
    `${label}.state must be one of ${Array.from(VALID_LIFECYCLE_STATES).join(', ')}`,
  );

  assert.ok(status.runtime && typeof status.runtime === 'object', `${label}.runtime must be an object`);
  assert.equal(typeof status.runtime.active, 'boolean', `${label}.runtime.active must be a boolean`);
  assert.equal(typeof status.updatedAtMs, 'number', `${label}.updatedAtMs must be a number`);
}

function assertOperation(status, expectedName, label = 'runtime status') {
  assert.ok(status.operation && typeof status.operation === 'object', `${label}.operation must be an object`);
  assert.equal(status.operation.name, expectedName, `${label}.operation.name should be "${expectedName}"`);
  assert.equal(typeof status.operation.startedAtMs, 'number', `${label}.operation.startedAtMs must be a number`);
}

function mapLoadout(slots = {}) {
  return new Map(Object.entries(slots).filter(([, code]) => !!code));
}

function makeGearCtx(name = 'Alpha', level = 10) {
  const char = {
    name,
    level,
    weapon_slot: 'none',
    shield_slot: 'none',
    helmet_slot: 'none',
    body_armor_slot: 'none',
    leg_armor_slot: 'none',
    boots_slot: 'none',
    ring1_slot: 'none',
    ring2_slot: 'none',
    amulet_slot: 'none',
    utility1_slot: '',
    utility1_slot_quantity: 0,
    utility2_slot: '',
    utility2_slot_quantity: 0,
    inventory: [],
  };

  return {
    name,
    get() {
      return char;
    },
    inventoryCapacity() {
      return 30;
    },
    itemCount() {
      return 0;
    },
  };
}

async function withIsolatedCwd(label, fn) {
  const tempDir = mkdtempSync(join(tmpdir(), `${label}-`));
  const originalCwd = process.cwd();
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function installDeterministicRuntimeStubs(manager) {
  const hooks = {
    startGate: null,
    stopGate: null,
    startCalls: 0,
    stopCalls: 0,
  };

  manager._startInternal = async function _startInternalStub() {
    hooks.startCalls += 1;
    this._setState('starting');

    const gate = hooks.startGate;
    if (gate) {
      await gate.promise;
      if (hooks.startGate === gate) hooks.startGate = null;
    }

    this.activeRun = {
      runId: hooks.startCalls,
      startedAtMs: Date.now(),
      configPath: './config/characters.json',
      characterNames: ['Alpha'],
    };
    this._clearError();
    this._setState('running');
    return this.getStatus();
  };

  manager._stopInternal = async function _stopInternalStub() {
    hooks.stopCalls += 1;
    this._setState('stopping');

    const gate = hooks.stopGate;
    if (gate) {
      await gate.promise;
      if (hooks.stopGate === gate) hooks.stopGate = null;
    }

    this.activeRun = null;
    this._setState('stopped');
    return this.getStatus();
  };

  manager._restartInternal = async function _restartInternalStub(gracefulTimeoutMs = this.defaultStopTimeoutMs) {
    if (this.activeRun) {
      await this._stopInternal(gracefulTimeoutMs);
    }
    return this._startInternal();
  };

  return {
    hooks,
    setStartGate(deferred) {
      hooks.startGate = deferred;
    },
    setStopGate(deferred) {
      hooks.stopGate = deferred;
    },
  };
}

async function testLifecycleTransitions(manager, controls) {
  const initial = manager.getStatus();
  assertStatusShape(initial, 'initial status');
  assert.equal(initial.state, 'stopped', 'initial runtime state should be stopped');

  const startGate = createDeferred();
  controls.setStartGate(startGate);
  const startPromise = manager.start();
  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'starting' && status.operation?.name === 'start';
  }, { label: 'start transition to starting' });

  let duringStart = manager.getStatus();
  assertStatusShape(duringStart, 'status during start');
  assert.equal(duringStart.state, 'starting', 'runtime should enter starting during start()');
  assertOperation(duringStart, 'start', 'status during start');

  startGate.resolve();
  await startPromise;

  const afterStart = manager.getStatus();
  assertStatusShape(afterStart, 'status after start');
  assert.equal(afterStart.state, 'running', 'runtime should be running after start()');
  assert.equal(afterStart.operation, null, 'operation should clear after start() completes');
  assert.equal(afterStart.runtime.active, true, 'runtime.active should be true after start()');

  const reloadStopGate = createDeferred();
  const reloadStartGate = createDeferred();
  controls.setStopGate(reloadStopGate);
  controls.setStartGate(reloadStartGate);

  const reloadPromise = manager.reloadConfig();
  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'stopping' && status.operation?.name === 'reload_config';
  }, { label: 'reload transition to stopping' });

  let duringReloadStop = manager.getStatus();
  assertStatusShape(duringReloadStop, 'status during reload stop phase');
  assert.equal(duringReloadStop.state, 'stopping', 'reload should transition through stopping');
  assertOperation(duringReloadStop, 'reload_config', 'status during reload stop phase');

  reloadStopGate.resolve();
  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'starting';
  }, { label: 'reload transition to starting' });

  let duringReloadStart = manager.getStatus();
  assertStatusShape(duringReloadStart, 'status during reload start phase');
  assert.equal(duringReloadStart.state, 'starting', 'reload should transition through starting');
  assertOperation(duringReloadStart, 'reload_config', 'status during reload start phase');

  reloadStartGate.resolve();
  await reloadPromise;

  const afterReload = manager.getStatus();
  assertStatusShape(afterReload, 'status after reload');
  assert.equal(afterReload.state, 'running', 'runtime should be running after reloadConfig()');
  assert.equal(afterReload.operation, null, 'operation should clear after reloadConfig()');
  assert.equal(afterReload.runtime.active, true, 'runtime should remain active after reloadConfig()');

  const restartStopGate = createDeferred();
  const restartStartGate = createDeferred();
  controls.setStopGate(restartStopGate);
  controls.setStartGate(restartStartGate);

  const restartPromise = manager.restart();
  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'stopping' && status.operation?.name === 'restart';
  }, { label: 'restart transition to stopping' });

  let duringRestartStop = manager.getStatus();
  assertStatusShape(duringRestartStop, 'status during restart stop phase');
  assert.equal(duringRestartStop.state, 'stopping', 'restart should transition through stopping');
  assertOperation(duringRestartStop, 'restart', 'status during restart stop phase');

  restartStopGate.resolve();
  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'starting';
  }, { label: 'restart transition to starting' });

  let duringRestartStart = manager.getStatus();
  assertStatusShape(duringRestartStart, 'status during restart start phase');
  assert.equal(duringRestartStart.state, 'starting', 'restart should transition through starting');
  assertOperation(duringRestartStart, 'restart', 'status during restart start phase');

  restartStartGate.resolve();
  await restartPromise;

  const afterRestart = manager.getStatus();
  assertStatusShape(afterRestart, 'status after restart');
  assert.equal(afterRestart.state, 'running', 'runtime should be running after restart()');
  assert.equal(afterRestart.operation, null, 'operation should clear after restart()');

  const stopGate = createDeferred();
  controls.setStopGate(stopGate);
  const stopPromise = manager.stop(25);

  await waitFor(() => {
    const status = manager.getStatus();
    return status.state === 'stopping' && status.operation?.name === 'stop';
  }, { label: 'stop transition to stopping' });

  let duringStop = manager.getStatus();
  assertStatusShape(duringStop, 'status during stop');
  assert.equal(duringStop.state, 'stopping', 'stop should transition through stopping');
  assertOperation(duringStop, 'stop', 'status during stop');

  stopGate.resolve();
  await stopPromise;

  const afterStop = manager.getStatus();
  assertStatusShape(afterStop, 'status after stop');
  assert.equal(afterStop.state, 'stopped', 'runtime should be stopped after stop()');
  assert.equal(afterStop.operation, null, 'operation should clear after stop()');
  assert.equal(afterStop.runtime.active, false, 'runtime.active should be false after stop()');
}

async function testOperationLockConflict(manager, controls) {
  await manager.start();
  assert.equal(manager.getStatus().state, 'running', 'runtime should be running before lock test');

  const lockStopGate = createDeferred();
  controls.setStopGate(lockStopGate);

  const inFlightReload = manager.reloadConfig();
  await waitFor(() => manager.getStatus().operation?.name === 'reload_config', {
    label: 'reload operation lock',
  });

  const restartAttempt = await Promise.allSettled([manager.restart()]);
  const [result] = restartAttempt;
  assert.equal(result.status, 'rejected', 'concurrent restart should reject while reload is in-flight');
  assert.equal(
    result.reason instanceof RuntimeOperationConflictError,
    true,
    'concurrent rejection should be RuntimeOperationConflictError',
  );
  assert.equal(result.reason.status, 409, 'concurrent rejection should map to 409');
  assert.equal(result.reason.code, 'operation_conflict', 'concurrent rejection code should be operation_conflict');

  lockStopGate.resolve();
  await inFlightReload;
  assert.equal(manager.getStatus().operation, null, 'operation should clear after locked reload completes');
}

async function testRolloutHardClearRunsOnce() {
  await withIsolatedCwd('runtime-rollout-test', async () => {
    _resetOrderBoardForTests();
    await initializeOrderBoard({ path: './report/order-board.json' });

    const manager = createRuntimeManager();
    createOrMergeOrder({
      requesterName: 'Alpha',
      recipeCode: 'gear_state:Alpha:iron_sword',
      itemCode: 'iron_sword',
      sourceType: 'craft',
      sourceCode: 'iron_sword',
      craftSkill: 'gearcrafting',
      sourceLevel: 10,
      quantity: 1,
    });
    assert.equal(getOrderBoardSnapshot().orders.length, 1, 'fixture should start with one active order');

    manager._runOrderBoardRolloutResetIfNeeded();
    assert.equal(getOrderBoardSnapshot().orders.length, 0, 'first rollout run should hard-clear board');
    assert.equal(existsSync('./report/.order-board-v2-rollout'), true, 'rollout marker should be written');

    createOrMergeOrder({
      requesterName: 'Alpha',
      recipeCode: 'gear_state:Alpha:iron_shield',
      itemCode: 'iron_shield',
      sourceType: 'craft',
      sourceCode: 'iron_shield',
      craftSkill: 'gearcrafting',
      sourceLevel: 10,
      quantity: 1,
    });
    assert.equal(getOrderBoardSnapshot().orders.length, 1, 'fixture should restore one order');

    manager._runOrderBoardRolloutResetIfNeeded();
    assert.equal(getOrderBoardSnapshot().orders.length, 1, 'marker should prevent repeated hard-clear');

    _resetOrderBoardForTests();
  });
}

async function testCleanupFlushesGearStateAndReleasesClaims() {
  await withIsolatedCwd('runtime-cleanup-test', async () => {
    _resetOrderBoardForTests();
    _resetGearStateForTests();

    await initializeOrderBoard({ path: './report/order-board.json' });
    const order = createOrMergeOrder({
      requesterName: 'Alpha',
      recipeCode: 'gear_state:Alpha:rare_blade',
      itemCode: 'rare_blade',
      sourceType: 'craft',
      sourceCode: 'rare_blade',
      craftSkill: 'gearcrafting',
      sourceLevel: 15,
      quantity: 2,
    });
    claimOrder(order.id, { charName: 'Alpha', leaseMs: 120_000 });
    assert.equal(getOrderBoardSnapshot().orders[0]?.status, 'claimed', 'fixture order should be claimed');

    const gearCtx = makeGearCtx('Alpha', 12);
    setGearStateDepsForTests({
      gameDataSvc: {
        findMonstersByLevel(maxLevel) {
          return [{ code: 'wolf', level: Math.min(12, maxLevel) }];
        },
        getItem() {
          return null;
        },
        getResourceForDrop() {
          return null;
        },
        getMonsterForDrop() {
          return null;
        },
      },
      optimizeForMonsterFn: async () => ({
        loadout: mapLoadout({ weapon: 'starter_sword' }),
        simResult: {
          win: true,
          hpLostPercent: 5,
          turns: 2,
          remainingHp: 99,
        },
      }),
      getBankRevisionFn: () => 1,
      globalCountFn: () => 1,
    });

    await initializeGearState({
      path: './report/gear-state.json',
      characters: [{
        name: 'Alpha',
        settings: {},
        routines: [{ type: 'skillRotation', orderBoard: { enabled: false } }],
      }],
    });
    registerContext(gearCtx);
    await refreshGearState({ force: true });
    assert.ok(getCharacterGearState('Alpha'), 'gear-state fixture should initialize');

    const manager = createRuntimeManager();
    let unsubActionCalls = 0;
    let unsubLogCalls = 0;

    await manager._cleanupRun({
      characterNames: ['Alpha'],
      schedulerEntries: [{ name: 'Alpha' }],
      unsubscribeActionEvents() {
        unsubActionCalls += 1;
      },
      unsubscribeLogEvents() {
        unsubLogCalls += 1;
      },
    });

    const snapshot = getOrderBoardSnapshot();
    assert.equal(snapshot.orders[0]?.status, 'open', 'cleanup should release claimed orders for active chars');
    assert.equal(snapshot.orders[0]?.claim, null, 'cleanup should clear active claim payload');
    assert.equal(unsubActionCalls, 1, 'cleanup should run action unsubscribe callback');
    assert.equal(unsubLogCalls, 1, 'cleanup should run log unsubscribe callback');
    assert.equal(existsSync('./report/gear-state.json'), true, 'cleanup should flush gear-state file');

    const persisted = JSON.parse(readFileSync('./report/gear-state.json', 'utf-8'));
    assert.equal(
      persisted?.characters?.Alpha != null,
      true,
      'persisted gear-state should include tracked character payload',
    );

    _resetOrderBoardForTests();
    _resetGearStateForTests();
  });
}

async function run() {
  const manager = createRuntimeManager({ defaultStopTimeoutMs: 25 });
  const controls = installDeterministicRuntimeStubs(manager);

  await testLifecycleTransitions(manager, controls);
  await testOperationLockConflict(manager, controls);
  await testRolloutHardClearRunsOnce();
  await testCleanupFlushesGearStateAndReleasesClaims();

  console.log('test-runtime-manager: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
