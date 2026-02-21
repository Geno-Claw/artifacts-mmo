#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARTIFACTS_TOKEN ||= 'test-token';
process.env.ARTIFACTS_API ||= 'https://artifacts-api.test';

const uiState = await import('../src/services/ui-state.mjs');
const {
  _resetUiStateForTests,
  initializeUiState,
  recordCharacterSnapshot,
  recordLog,
} = uiState;
const orderBoard = await import('../src/services/order-board.mjs');
const {
  _resetOrderBoardForTests,
  claimOrder,
  createOrMergeOrder,
  initializeOrderBoard,
} = orderBoard;

function assertHasKeys(obj, keys, label) {
  assert.ok(obj && typeof obj === 'object', `${label} must be an object`);
  for (const key of keys) {
    assert.equal(Object.hasOwn(obj, key), true, `${label} missing key "${key}"`);
  }
}

function assertSnapshotCharacterShape(char, label = 'snapshot character') {
  assertHasKeys(char, [
    'name',
    'portraitType',
    'status',
    'stale',
    'lastUpdatedAtMs',
    'level',
    'hp',
    'maxHp',
    'xp',
    'maxXp',
    'position',
    'routine',
    'cooldown',
    'task',
    'logLatest',
    'logHistory',
  ], label);
  assert.equal(typeof char.name, 'string');
  assert.equal(typeof char.portraitType, 'string');
  assert.equal(typeof char.status, 'string');
  assert.equal(typeof char.stale, 'boolean');
  assert.equal(typeof char.lastUpdatedAtMs, 'number');
  assert.equal(typeof char.level, 'number');
  assert.equal(typeof char.hp, 'number');
  assert.equal(typeof char.maxHp, 'number');
  assert.equal(typeof char.xp, 'number');
  assert.equal(typeof char.maxXp, 'number');
  assert.equal(typeof char.logLatest, 'string');
  assert.ok(Array.isArray(char.logHistory));
}

function assertSnapshotShape(snapshot, label = 'snapshot payload') {
  assertHasKeys(snapshot, ['serverTimeMs', 'configPath', 'startedAtMs', 'characters'], label);
  assert.equal(typeof snapshot.serverTimeMs, 'number');
  assert.equal(typeof snapshot.configPath, 'string');
  assert.equal(typeof snapshot.startedAtMs, 'number');
  assert.ok(Array.isArray(snapshot.characters), `${label}.characters must be an array`);
  for (const [idx, char] of snapshot.characters.entries()) {
    assertSnapshotCharacterShape(char, `${label}.characters[${idx}]`);
  }
}

function assertOrderRowShape(row, label = 'order row') {
  assertHasKeys(row, [
    'id',
    'itemCode',
    'sourceType',
    'sourceCode',
    'requestedQty',
    'remainingQty',
    'status',
  ], label);
  assert.equal(typeof row.id, 'string');
  assert.equal(typeof row.itemCode, 'string');
  assert.equal(typeof row.sourceType, 'string');
  assert.equal(typeof row.sourceCode, 'string');
  assert.equal(typeof row.requestedQty, 'number');
  assert.equal(typeof row.remainingQty, 'number');
  assert.equal(typeof row.status, 'string');
}

function assertOrdersPayloadShape(payload, label = 'orders payload') {
  assert.ok(payload && typeof payload === 'object', `${label} must be an object`);
  assert.ok(Array.isArray(payload.orders), `${label}.orders must be an array`);
  if (Object.hasOwn(payload, 'updatedAtMs')) {
    assert.equal(typeof payload.updatedAtMs, 'number', `${label}.updatedAtMs must be numeric`);
  }
  for (const [idx, row] of payload.orders.entries()) {
    assertOrderRowShape(row, `${label}.orders[${idx}]`);
  }
}

function assertCharacterDetailShape(detail, expectedName) {
  assertHasKeys(detail, [
    'identity',
    'skills',
    'inventory',
    'equipment',
    'stats',
    'logHistory',
    'updatedAtMs',
  ], 'character detail payload');

  assertHasKeys(detail.identity, ['name', 'status', 'stale', 'level'], 'detail.identity');
  assert.equal(detail.identity.name, expectedName);
  assert.equal(typeof detail.identity.status, 'string');
  assert.equal(typeof detail.identity.stale, 'boolean');
  assert.equal(typeof detail.identity.level, 'number');

  assert.ok(Array.isArray(detail.skills), 'detail.skills must be an array');
  for (const [idx, skill] of detail.skills.entries()) {
    assertHasKeys(skill, ['code', 'level', 'xp', 'maxXp', 'pct'], `detail.skills[${idx}]`);
    assert.equal(typeof skill.code, 'string');
    assert.equal(typeof skill.level, 'number');
    assert.equal(typeof skill.xp, 'number');
    assert.equal(typeof skill.maxXp, 'number');
    assert.equal(typeof skill.pct, 'number');
  }

  assert.ok(Array.isArray(detail.inventory), 'detail.inventory must be an array');
  for (const [idx, item] of detail.inventory.entries()) {
    assertHasKeys(item, ['code', 'quantity', 'slotIndex'], `detail.inventory[${idx}]`);
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.quantity, 'number');
    assert.equal(typeof item.slotIndex, 'number');
  }

  assert.ok(Array.isArray(detail.equipment), 'detail.equipment must be an array');
  for (const [idx, item] of detail.equipment.entries()) {
    assertHasKeys(item, ['slot', 'code', 'quantity'], `detail.equipment[${idx}]`);
    assert.equal(typeof item.slot, 'string');
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.quantity, 'number');
  }

  assertHasKeys(detail.stats, ['hp', 'maxHp', 'xp', 'maxXp', 'gold', 'position'], 'detail.stats');
  assert.equal(typeof detail.stats.hp, 'number');
  assert.equal(typeof detail.stats.maxHp, 'number');
  assert.equal(typeof detail.stats.xp, 'number');
  assert.equal(typeof detail.stats.maxXp, 'number');
  assert.equal(typeof detail.stats.gold, 'number');
  assertHasKeys(detail.stats.position, ['x', 'y', 'layer'], 'detail.stats.position');

  const hasTaskFields = Object.hasOwn(detail.stats, 'task')
    || Object.hasOwn(detail.stats, 'taskName')
    || Object.hasOwn(detail.stats, 'taskLabel')
    || Object.hasOwn(detail.stats, 'taskProgress');
  assert.equal(hasTaskFields, true, 'detail.stats should expose task fields');

  assert.ok(Array.isArray(detail.logHistory), 'detail.logHistory must be an array');
  for (const [idx, entry] of detail.logHistory.entries()) {
    assertHasKeys(entry, ['atMs', 'level', 'line'], `detail.logHistory[${idx}]`);
    assert.equal(typeof entry.atMs, 'number');
    assert.equal(typeof entry.level, 'string');
    assert.equal(typeof entry.line, 'string');
  }

  assert.equal(typeof detail.updatedAtMs, 'number');
}

function getFirstPresent(obj, keys) {
  for (const key of keys) {
    if (Object.hasOwn(obj, key)) return obj[key];
  }
  return undefined;
}

function assertAccountSummaryShape(summary) {
  assert.ok(summary && typeof summary === 'object' && !Array.isArray(summary), 'account summary must be an object');

  const identity = summary.identity && typeof summary.identity === 'object' ? summary.identity : summary;
  const account = getFirstPresent(identity, ['account', 'accountName', 'name', 'username']);
  assert.equal(typeof account, 'string', 'account summary must expose account identifier');

  const totals = summary.achievements && typeof summary.achievements === 'object'
    ? summary.achievements
    : (summary.totals && typeof summary.totals === 'object' ? summary.totals : summary);
  const completed = getFirstPresent(totals, ['completed', 'completedCount', 'completedTotal']);
  const total = getFirstPresent(
    totals,
    ['total', 'totalCount', 'available', 'availableTotal', 'totalAvailable', 'totalVisible'],
  );
  assert.equal(typeof completed, 'number', 'account summary must expose completed total');
  assert.equal(typeof total, 'number', 'account summary must expose total/available count');
  assert.ok(total >= completed, 'account summary total/available should be >= completed');

  const inProgress = getFirstPresent(totals, ['inProgress', 'in_progress', 'ongoing']);
  if (inProgress !== undefined) {
    assert.equal(typeof inProgress, 'number', 'account summary inProgress must be numeric');
  }
}

function assertAchievementShape(entry, label) {
  assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `${label} must be an object`);
  const code = getFirstPresent(entry, ['code', 'id']);
  const title = getFirstPresent(entry, ['name', 'title', 'label']);
  assert.equal(typeof code, 'string', `${label} missing code/id`);
  assert.equal(typeof title, 'string', `${label} missing name/title`);

  if (Array.isArray(entry.objectives) && entry.objectives.length > 0) {
    for (const [oi, obj] of entry.objectives.entries()) {
      assert.equal(typeof obj.total, 'number', `${label}.objectives[${oi}] missing total`);
    }
    return;
  }

  const completed = getFirstPresent(entry, ['completed', 'isCompleted', 'done']);
  const progress = getFirstPresent(entry, ['progress', 'current', 'value']);
  const total = getFirstPresent(entry, ['total', 'target', 'max']);
  const completedAt = getFirstPresent(entry, ['completedAt', 'completed_at']);
  const hasCompletionSignal = typeof completed === 'boolean'
    || (typeof progress === 'number' && typeof total === 'number')
    || completedAt !== undefined;
  assert.equal(hasCompletionSignal, true, `${label} missing completion signal`);
}

function assertAccountAchievementsShape(payload) {
  let rows = null;
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    assert.ok(payload && typeof payload === 'object', 'account achievements payload must be object/array');
    const account = getFirstPresent(payload, ['account', 'accountName', 'name']);
    if (account !== undefined) {
      assert.equal(typeof account, 'string', 'account achievements account field must be a string');
    }
    rows = getFirstPresent(payload, ['achievements', 'items', 'data']);
    assert.ok(Array.isArray(rows), 'account achievements payload must include achievements array');
  }

  for (const [idx, row] of rows.entries()) {
    assertAchievementShape(row, `account achievements[${idx}]`);
  }
}

function assertConfigPayloadShape(payload, label = 'config payload') {
  assertHasKeys(payload, ['path', 'hash', 'config'], label);
  assert.equal(typeof payload.path, 'string', `${label}.path must be a string`);
  assert.equal(typeof payload.hash, 'string', `${label}.hash must be a string`);
  assert.ok(payload.config && typeof payload.config === 'object', `${label}.config must be an object`);
}

function assertValidationErrorsShape(errors, label = 'validation errors') {
  assert.ok(Array.isArray(errors), `${label} must be an array`);
  assert.ok(errors.length > 0, `${label} must not be empty`);
  for (const [idx, entry] of errors.entries()) {
    assertHasKeys(entry, ['path', 'message'], `${label}[${idx}]`);
    assert.equal(typeof entry.path, 'string', `${label}[${idx}].path must be a string`);
    assert.equal(typeof entry.message, 'string', `${label}[${idx}].message must be a string`);
  }
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateConfigName(config, suffix) {
  const next = deepCloneJson(config);
  assert.ok(Array.isArray(next.characters), 'config.characters must be an array');
  assert.ok(next.characters.length > 0, 'config.characters must not be empty');
  const first = next.characters[0] || {};
  const baseName = `${first.name || 'TestCharacter'}`.trim() || 'TestCharacter';
  next.characters[0] = {
    ...first,
    name: `${baseName}_${suffix}`,
  };
  return next;
}

function createConfigFixture(rootDir) {
  const tempDir = mkdtempSync(join(tmpdir(), 'dashboard-config-test-'));
  const configPath = join(tempDir, 'characters.json');
  const sourcePath = resolve(rootDir, 'config/characters-local.json');
  copyFileSync(sourcePath, configPath);

  return {
    tempDir,
    configPath,
  };
}

function readTextFromFd(fd) {
  const stat = fs.fstatSync(fd);
  const size = Number(stat.size) || 0;
  if (size <= 0) return '';
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, 0);
  return buf.toString('utf-8');
}

function openAtomicProbe(configPath) {
  const fd = fs.openSync(configPath, 'r');
  return {
    fd,
    inode: fs.fstatSync(fd).ino,
    text: readTextFromFd(fd),
    close() {
      fs.closeSync(fd);
    },
  };
}

function assertAtomicReplaceBehavior(configPath, probe) {
  const currentStat = fs.statSync(configPath);
  assert.notEqual(
    currentStat.ino,
    probe.inode,
    'save should replace config via rename (inode should change)',
  );
  assert.equal(
    readTextFromFd(probe.fd),
    probe.text,
    'pre-save descriptor should keep seeing old bytes after atomic rename',
  );
}

function createJsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function normalizeFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const headers = {};
  let requestBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: requestBody,
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (err) {
      assert.fail(`Expected JSON from ${method} ${url}; parse failed: ${err.message}; body=${text}`);
    }
  }

  return { res, payload };
}

function createArtifactsApiMock(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const state = {
    detailsCalls: 0,
    achievementCalls: 0,
  };

  const summary = {
    account: 'qa-account',
    completed: 1,
    total: 3,
    inProgress: 2,
  };

  const definitions = [
    {
      code: 'first_steps',
      name: 'First Steps',
      description: 'Take your first steps in the world.',
      points: 1,
      objectives: [{ type: 'combat_level', target: null, total: 1 }],
      rewards: { gold: 100, items: [] },
    },
    {
      code: 'ore_hoarder',
      name: 'Ore Hoarder',
      description: 'Collect ores from across the land.',
      points: 2,
      objectives: [{ type: 'gathering', target: 'copper_ore', total: 100 }],
      rewards: { gold: 500, items: [{ code: 'copper_ore', quantity: 10 }] },
    },
    {
      code: 'in_every_color',
      name: 'In Every Color',
      description: 'Hunt 50 of each slime color.',
      points: 3,
      objectives: [
        { type: 'combat_kill', target: 'red_slime', total: 50 },
        { type: 'combat_kill', target: 'blue_slime', total: 50 },
        { type: 'combat_kill', target: 'yellow_slime', total: 50 },
        { type: 'combat_kill', target: 'green_slime', total: 50 },
      ],
      rewards: { gold: 1000, items: [{ code: 'apple', quantity: 10 }] },
    },
  ];

  const accountAchievements = [
    {
      code: 'first_steps',
      name: 'First Steps',
      completed: true,
      completed_at: '2024-01-01T00:00:00Z',
      objectives: [{ type: 'combat_level', target: null, total: 1, progress: 1 }],
    },
    {
      code: 'ore_hoarder',
      name: 'Ore Hoarder',
      completed: false,
      objectives: [{ type: 'gathering', target: 'copper_ore', total: 100, progress: 12 }],
    },
    {
      code: 'in_every_color',
      name: 'In Every Color',
      completed: false,
      objectives: [
        { type: 'combat_kill', target: 'red_slime', total: 50, progress: 50 },
        { type: 'combat_kill', target: 'blue_slime', total: 50, progress: 23 },
        { type: 'combat_kill', target: 'yellow_slime', total: 50, progress: 0 },
        { type: 'combat_kill', target: 'green_slime', total: 50, progress: 5 },
      ],
    },
  ];

  return {
    state,
    handles(urlText) {
      return urlText.startsWith(normalizedBase);
    },
    async fetch(urlText) {
      const url = new URL(urlText);
      if (url.pathname === '/my/details') {
        state.detailsCalls++;
        return createJsonResponse(200, {
          data: {
            account: summary.account,
            username: summary.account,
            achievements: {
              completed: summary.completed,
              total: summary.total,
              inProgress: summary.inProgress,
            },
            achievements_completed: summary.completed,
            achievements_total: summary.total,
          },
        });
      }

      if (url.pathname === '/achievements') {
        state.achievementCalls++;
        return createJsonResponse(200, {
          data: definitions,
          total: definitions.length,
          page: 1,
          size: 100,
          pages: 1,
        });
      }

      if (url.pathname.includes('/achievements')) {
        state.achievementCalls++;
        return createJsonResponse(200, { data: accountAchievements });
      }

      return createJsonResponse(404, {
        error: {
          code: 404,
          message: `No mock for ${url.pathname}`,
        },
      });
    },
  };
}

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

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  if (lastErr) {
    throw new Error(`Timed out waiting for ${label}: ${lastErr.message}`);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function extractLifecycleState(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const direct = getFirstPresent(payload, ['lifecycle', 'state', 'lifecycleState', 'runtimeState', 'status']);
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  if (direct && typeof direct === 'object') {
    const nested = getFirstPresent(direct, ['lifecycle', 'state', 'lifecycleState', 'status']);
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }

  if (payload.runtime && typeof payload.runtime === 'object') {
    const nested = getFirstPresent(payload.runtime, ['lifecycle', 'state', 'lifecycleState', 'status']);
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }

  return '';
}

function assertControlStatusShape(payload, label = 'control status payload') {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), `${label} must be an object`);

  const lifecycle = extractLifecycleState(payload).toLowerCase();
  const lifecycleStates = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
  assert.equal(Boolean(lifecycle), true, `${label} must include lifecycle state string`);
  assert.equal(
    lifecycleStates.has(lifecycle),
    true,
    `${label} lifecycle must be one of ${Array.from(lifecycleStates).join(', ')} (got "${lifecycle}")`,
  );

  const busy = getFirstPresent(payload, ['busy', 'inFlight', 'operationInFlight', 'locked']);
  const lock = payload.lock;
  const operation = payload.operation;
  const hasLockSignal = typeof busy === 'boolean'
    || typeof lock === 'boolean'
    || (lock && typeof lock === 'object')
    || typeof operation === 'string'
    || (operation && typeof operation === 'object');
  assert.equal(hasLockSignal, true, `${label} must include lock/operation signal`);

  if (Object.hasOwn(payload, 'updatedAtMs')) {
    assert.equal(typeof payload.updatedAtMs, 'number', `${label}.updatedAtMs must be numeric`);
  }
}

function assertControlSuccessShape(payload, label) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), `${label} payload must be an object`);
  const ok = getFirstPresent(payload, ['ok', 'success']);
  if (ok !== undefined) {
    assert.equal(Boolean(ok), true, `${label} should report success`);
  }
  const operation = getFirstPresent(payload, ['operation', 'action', 'op']);
  if (operation !== undefined) {
    assert.equal(typeof operation, 'string', `${label} operation should be a string`);
  }
}

function createControlConflictError(activeOperation) {
  const err = new Error(`Operation already in-flight: ${activeOperation}`);
  err.status = 409;
  err.code = 'operation_in_flight';
  return err;
}

function createRuntimeControlMock() {
  const state = {
    lifecycle: 'running',
    inFlight: null,
    statusCalls: 0,
    reloadCalls: 0,
    restartCalls: 0,
    gates: new Map(),
  };

  function setGate(operation, deferred) {
    state.gates.set(operation, deferred);
  }

  async function runOperation(operation, {
    enteringState = null,
    intermediateState = null,
    finalState = 'running',
  } = {}) {
    if (state.inFlight) {
      throw createControlConflictError(state.inFlight);
    }

    state.inFlight = operation;
    if (enteringState) state.lifecycle = enteringState;

    try {
      const gate = state.gates.get(operation);
      if (gate) {
        await gate.promise;
      }

      if (intermediateState) state.lifecycle = intermediateState;
      state.lifecycle = finalState;
      return {
        ok: true,
        operation,
        lifecycle: state.lifecycle,
        inFlight: false,
        updatedAtMs: Date.now(),
      };
    } finally {
      state.gates.delete(operation);
      state.inFlight = null;
    }
  }

  const api = {
    state,
    setGate,
    async waitForInFlight(operation, timeoutMs = 1_000) {
      await waitFor(() => state.inFlight === operation, {
        timeoutMs,
        label: `runtime mock in-flight ${operation}`,
      });
    },
    getStatus() {
      state.statusCalls += 1;
      return {
        lifecycle: state.lifecycle,
        inFlight: Boolean(state.inFlight),
        operation: state.inFlight ? { name: state.inFlight, inFlight: true } : null,
        lock: {
          inFlight: Boolean(state.inFlight),
          operation: state.inFlight,
        },
        updatedAtMs: Date.now(),
      };
    },
    status() {
      return api.getStatus();
    },
    async start() {
      state.lifecycle = 'running';
      return {
        ok: true,
        operation: 'start',
        lifecycle: state.lifecycle,
        updatedAtMs: Date.now(),
      };
    },
    async stop() {
      state.lifecycle = 'stopped';
      return {
        ok: true,
        operation: 'stop',
        lifecycle: state.lifecycle,
        updatedAtMs: Date.now(),
      };
    },
    async reloadConfig() {
      state.reloadCalls += 1;
      return runOperation('reload-config', {
        enteringState: 'running',
        finalState: 'running',
      });
    },
    async reload() {
      return api.reloadConfig();
    },
    async restart() {
      state.restartCalls += 1;
      return runOperation('restart', {
        enteringState: 'stopping',
        intermediateState: 'starting',
        finalState: 'running',
      });
    },
  };

  return api;
}

function parseSseEvent(rawBlock) {
  const lines = rawBlock.split('\n');
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;

  return {
    event,
    data: JSON.parse(dataLines.join('\n')),
  };
}

async function readWithTimeout(reader, timeoutMs) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('SSE read timeout')), timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function openSse(url) {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, `SSE endpoint returned ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function nextEvent(timeoutMs = 1_000) {
    const timeoutAt = Date.now() + timeoutMs;

    while (Date.now() < timeoutAt) {
      const splitIdx = buffer.indexOf('\n\n');
      if (splitIdx >= 0) {
        const block = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        const parsed = parseSseEvent(block);
        if (parsed) return parsed;
        continue;
      }

      const msRemaining = Math.max(1, timeoutAt - Date.now());
      const chunk = await readWithTimeout(reader, msRemaining);
      if (chunk.done) {
        throw new Error('SSE stream closed unexpectedly');
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }

    throw new Error('Timed out waiting for SSE event');
  }

  return {
    nextEvent,
    async close() {
      try {
        await reader.cancel();
      } catch {
        // No-op
      }
    },
  };
}

async function nextSseEvent(sse, eventName, maxEvents = 20, timeoutMs = 1_500) {
  for (let i = 0; i < maxEvents; i++) {
    const evt = await sse.nextEvent(timeoutMs);
    if (evt.event === eventName) return evt;
  }
  throw new Error(`Timed out waiting for SSE "${eventName}" event`);
}

async function resolvesWithin(promise, timeoutMs) {
  let timerId = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => false),
      new Promise(resolve => {
        timerId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function run() {
  const rootDir = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const configFixture = createConfigFixture(rootDir);
  const originalFetch = globalThis.fetch;
  const originalBotConfig = process.env.BOT_CONFIG;
  const originalBotConfigSchema = process.env.BOT_CONFIG_SCHEMA;
  const apiMock = createArtifactsApiMock(process.env.ARTIFACTS_API || 'https://artifacts-api.test');
  const runtimeControlMock = createRuntimeControlMock();
  let dashboard = null;
  let sse = null;
  let closeRegressionDashboard = null;
  let closeRegressionSse = null;
  const orderBoardPath = join(configFixture.tempDir, 'order-board.json');
  try {
    process.env.BOT_CONFIG = configFixture.configPath;
    process.env.BOT_CONFIG_SCHEMA = resolve(rootDir, 'config/characters.schema.json');

    const { startDashboardServer } = await import('../src/dashboard-server.mjs');

    globalThis.fetch = async (input, init) => {
      const urlText = normalizeFetchUrl(input);
      if (apiMock.handles(urlText)) {
        return apiMock.fetch(urlText, init);
      }
      return originalFetch(input, init);
    };

    _resetUiStateForTests();
    initializeUiState({
      characterNames: ['Alpha'],
      configPath: './config/characters.json',
      startedAt: 123,
      logLimit: 120,
    });

    recordCharacterSnapshot('Alpha', {
      level: 12,
      hp: 140,
      max_hp: 200,
      xp: 5600,
      max_xp: 8000,
      x: 3,
      y: 9,
      layer: 'overworld',
      gold: 777,
      task: 'chicken',
      task_type: 'monsters',
      task_progress: 17,
      task_total: 50,
      mining_level: 9,
      mining_xp: 410,
      mining_max_xp: 1000,
      woodcutting_level: 4,
      woodcutting_xp: 120,
      woodcutting_max_xp: 400,
      fishing_level: 2,
      fishing_xp: 70,
      fishing_max_xp: 250,
      weaponcrafting_level: 3,
      weaponcrafting_xp: 44,
      weaponcrafting_max_xp: 200,
      inventory: [
        { slot: 1, code: 'copper_ore', quantity: 12 },
        { slot: 2, code: 'spruce_log', quantity: 3 },
        { slot: 3, code: null, quantity: 0 },
      ],
      weapon_slot: 'copper_sword',
      weapon_slot_quantity: 1,
      helmet_slot: 'wooden_helmet',
      helmet_slot_quantity: 1,
      ring1_slot: 'topaz_ring',
      ring1_slot_quantity: 1,
    });

    for (let i = 0; i < 65; i++) {
      recordLog('Alpha', {
        level: 'info',
        line: `detail-log-${i}`,
        at: i,
      });
    }

    _resetOrderBoardForTests();
    await initializeOrderBoard({ path: orderBoardPath });
    const seedOrder = createOrMergeOrder({
      requesterName: 'CrafterAlpha',
      recipeCode: 'bronze_dagger',
      itemCode: 'copper_ore',
      sourceType: 'gather',
      sourceCode: 'copper_rocks',
      gatherSkill: 'mining',
      sourceLevel: 10,
      quantity: 3,
    });
    assert.ok(seedOrder, 'expected order board seed order');
    const claimResult = claimOrder(seedOrder.id, { charName: 'WorkerAlpha', leaseMs: 10_000 });
    assert.ok(claimResult, 'expected order board seed claim');

    dashboard = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      rootDir,
      heartbeatMs: 100,
      broadcastDebounceMs: 20,
      runtimeManager: runtimeControlMock,
      runtime: runtimeControlMock,
      controlRuntime: runtimeControlMock,
    });

    const baseUrl = `http://127.0.0.1:${dashboard.port}`;
    sse = await openSse(`${baseUrl}/api/ui/events`);

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const dashboardPageRes = await fetch(`${baseUrl}/`);
    assert.equal(dashboardPageRes.status, 200, 'dashboard root should return HTML');
    const dashboardHtml = await dashboardPageRes.text();
    assert.equal(typeof dashboardHtml, 'string', 'dashboard root response should be text');
    assert.equal(
      dashboardHtml.includes('id="ordersPanel"'),
      true,
      'dashboard HTML should include ordersPanel',
    );
    assert.equal(
      dashboardHtml.includes('id="ordersList"'),
      true,
      'dashboard HTML should include ordersList',
    );
    assert.equal(
      dashboardHtml.includes('id="ordersPanelMeta"'),
      true,
      'dashboard HTML should include ordersPanelMeta',
    );
    assert.equal(
      dashboardHtml.includes('data-order-filter="all"'),
      true,
      'dashboard HTML should include all orders filter control',
    );
    assert.equal(
      dashboardHtml.includes('data-order-filter="claimed"'),
      true,
      'dashboard HTML should include claimed orders filter control',
    );
    assert.equal(
      dashboardHtml.includes('data-order-filter="hidden"'),
      true,
      'dashboard HTML should include hide orders filter control',
    );

    const snapshotRes = await fetch(`${baseUrl}/api/ui/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = await snapshotRes.json();
    assertSnapshotShape(snapshot);
    assert.ok(Array.isArray(snapshot.orders), 'snapshot should include top-level orders array');
    assert.ok(snapshot.orders.length >= 1, 'snapshot should include seeded order');
    assertOrderRowShape(snapshot.orders[0], 'snapshot.orders[0]');
    assert.equal(snapshot.characters.length, 1);
    assert.equal(snapshot.characters[0].name, 'Alpha');

    const ordersRes = await fetch(`${baseUrl}/api/ui/orders`);
    assert.equal(ordersRes.status, 200, 'orders endpoint should return 200');
    const ordersPayload = await ordersRes.json();
    assertOrdersPayloadShape(ordersPayload, 'GET /api/ui/orders payload');
    assert.ok(ordersPayload.orders.length >= 1, 'orders endpoint should include seeded order');

    const detailRes = await fetch(`${baseUrl}/api/ui/character/${encodeURIComponent('Alpha')}`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assertCharacterDetailShape(detail, 'Alpha');
    assert.equal(detail.skills.length > 0, true, 'Expected non-empty normalized skills');
    assert.equal(detail.inventory.length > 0, true, 'Expected non-empty normalized inventory');
    assert.equal(detail.equipment.length > 0, true, 'Expected non-empty normalized equipment');
    assert.equal(detail.logHistory.length, 50, 'Expected detail logHistory cap at 50 entries');
    assert.equal(detail.logHistory.some(entry => entry.line === 'detail-log-64'), true);
    assert.equal(detail.logHistory.some(entry => entry.line === 'detail-log-0'), false);

    const missingRes = await fetch(`${baseUrl}/api/ui/character/${encodeURIComponent('Missing')}`);
    assert.equal(missingRes.status, 404);
    const missingPayload = await missingRes.json();
    assert.equal(typeof missingPayload.error, 'string');

    const initialEvent = await sse.nextEvent(1_500);
    assert.equal(initialEvent.event, 'snapshot');
    assertSnapshotShape(initialEvent.data, 'initial SSE snapshot');
    assert.ok(Array.isArray(initialEvent.data.orders), 'initial SSE snapshot should include orders array');
    assert.equal(initialEvent.data.characters.length, 1);

    recordLog('Alpha', {
      level: 'info',
      line: '[Alpha] test log line',
      at: Date.now(),
    });

    const mutationEvent = await nextSseEvent(sse, 'snapshot', 25, 1_500);
    assert.equal(mutationEvent.data.characters[0].logLatest, '[Alpha] test log line');
    assertSnapshotShape(mutationEvent.data, 'mutation SSE snapshot');

    const heartbeatEvent = await nextSseEvent(sse, 'heartbeat', 25, 1_500);
    assert.equal(typeof heartbeatEvent.data.serverTimeMs, 'number');

    const accountSummaryRes = await fetch(`${baseUrl}/api/ui/account/summary`, { cache: 'no-store' });
    assert.equal(accountSummaryRes.status, 200, `Expected /api/ui/account/summary 200, got ${accountSummaryRes.status}`);
    const accountSummaryPayload = await accountSummaryRes.json();
    assertAccountSummaryShape(accountSummaryPayload);

    const accountAchievementsRes = await fetch(`${baseUrl}/api/ui/account/achievements`, { cache: 'no-store' });
    assert.equal(accountAchievementsRes.status, 200, `Expected /api/ui/account/achievements 200, got ${accountAchievementsRes.status}`);
    const accountAchievementsPayload = await accountAchievementsRes.json();
    assertAccountAchievementsShape(accountAchievementsPayload);

    // Verify per-objective progress is correctly propagated (beta API uses "progress" not "current")
    const rows = accountAchievementsPayload.achievements || accountAchievementsPayload.data || [];
    const slimeAch = rows.find(r => r.code === 'in_every_color');
    assert.ok(slimeAch, 'Expected in_every_color achievement in response');
    assert.ok(Array.isArray(slimeAch.objectives) && slimeAch.objectives.length === 4,
      'Expected 4 objectives for in_every_color');
    const redSlime = slimeAch.objectives.find(o => o.target === 'red_slime');
    assert.equal(redSlime.current, 50, 'red_slime progress should be 50 (from API "progress" field)');
    const blueSlime = slimeAch.objectives.find(o => o.target === 'blue_slime');
    assert.equal(blueSlime.current, 23, 'blue_slime progress should be 23');
    const greenSlime = slimeAch.objectives.find(o => o.target === 'green_slime');
    assert.equal(greenSlime.current, 5, 'green_slime progress should be 5');

    assert.ok(apiMock.state.detailsCalls >= 1, 'Expected account summary endpoint to call upstream details at least once');
    assert.ok(apiMock.state.achievementCalls >= 1, 'Expected account achievements endpoint to call upstream achievements at least once');

    // Phase 4: config API contract tests.
    const getConfig = await requestJson(`${baseUrl}/api/config`);
    assert.equal(getConfig.res.status, 200, `Expected /api/config 200, got ${getConfig.res.status}`);
    assertConfigPayloadShape(getConfig.payload, 'GET /api/config payload');
    assert.equal(
      resolve(getConfig.payload.path),
      resolve(configFixture.configPath),
      'GET /api/config should return active BOT_CONFIG path',
    );

    const validateValid = await requestJson(`${baseUrl}/api/config/validate`, {
      method: 'POST',
      body: { config: deepCloneJson(getConfig.payload.config) },
    });
    assert.equal(validateValid.res.status, 200, `Expected /api/config/validate 200, got ${validateValid.res.status}`);
    assert.equal(validateValid.payload?.ok, true, 'valid config should return ok=true');
    assert.ok(Array.isArray(validateValid.payload?.errors), 'valid config response should include errors array');
    assert.equal(validateValid.payload.errors.length, 0, 'valid config should return empty errors array');

    const validateInvalid = await requestJson(`${baseUrl}/api/config/validate`, {
      method: 'POST',
      body: { config: { characters: [{ name: 'MissingRoutines' }] } },
    });
    assert.equal(validateInvalid.res.status, 200, `Expected invalid /api/config/validate 200, got ${validateInvalid.res.status}`);
    assert.equal(validateInvalid.payload?.ok, false, 'invalid config should return ok=false');
    assertValidationErrorsShape(validateInvalid.payload?.errors, 'invalid config errors');

    const staleHash = `${getConfig.payload.hash}`;
    const savedConfig = mutateConfigName(getConfig.payload.config, 'phase4save');
    const atomicProbe = openAtomicProbe(configFixture.configPath);
    let saveRes;
    try {
      saveRes = await requestJson(`${baseUrl}/api/config`, {
        method: 'PUT',
        body: {
          config: savedConfig,
          ifMatchHash: staleHash,
        },
      });
      assertAtomicReplaceBehavior(configFixture.configPath, atomicProbe);
    } finally {
      atomicProbe.close();
    }
    assert.equal(saveRes.res.status, 200, `Expected /api/config PUT 200, got ${saveRes.res.status}`);
    assertHasKeys(saveRes.payload, ['ok', 'hash', 'savedAtMs'], 'PUT /api/config success payload');
    assert.equal(saveRes.payload.ok, true, 'successful save should return ok=true');
    assert.equal(typeof saveRes.payload.hash, 'string', 'successful save should return new hash string');
    assert.equal(typeof saveRes.payload.savedAtMs, 'number', 'successful save should return numeric savedAtMs');

    const savedDiskConfig = JSON.parse(readFileSync(configFixture.configPath, 'utf-8'));
    assert.equal(
      savedDiskConfig?.characters?.[0]?.name,
      savedConfig?.characters?.[0]?.name,
      'successful save should persist updated config to disk',
    );

    const conflictInodeBefore = fs.statSync(configFixture.configPath).ino;
    const beforeConflictRaw = readFileSync(configFixture.configPath, 'utf-8');
    const conflictRes = await requestJson(`${baseUrl}/api/config`, {
      method: 'PUT',
      body: {
        config: mutateConfigName(savedConfig, 'phase4conflict'),
        ifMatchHash: staleHash,
      },
    });
    assert.equal(conflictRes.res.status, 409, `Expected stale hash /api/config PUT to return 409, got ${conflictRes.res.status}`);
    assert.equal(typeof conflictRes.payload?.error, 'string', 'conflict response should include error');

    const conflictInodeAfter = fs.statSync(configFixture.configPath).ino;
    assert.equal(conflictInodeAfter, conflictInodeBefore, 'stale hash should not replace config file');
    const afterConflictRaw = readFileSync(configFixture.configPath, 'utf-8');
    assert.equal(afterConflictRaw, beforeConflictRaw, 'stale hash conflict should not mutate persisted config');

    // Phase 5: runtime control API contract tests.
    const controlStatus = await requestJson(`${baseUrl}/api/control/status`);
    assert.equal(
      controlStatus.res.status,
      200,
      `Expected /api/control/status 200, got ${controlStatus.res.status}`,
    );
    assertControlStatusShape(controlStatus.payload, 'GET /api/control/status payload');

    const reloadControl = await requestJson(`${baseUrl}/api/control/reload-config`, { method: 'POST' });
    assert.equal(
      reloadControl.res.status,
      200,
      `Expected /api/control/reload-config 200, got ${reloadControl.res.status}`,
    );
    assertControlSuccessShape(reloadControl.payload, 'POST /api/control/reload-config');

    const restartControl = await requestJson(`${baseUrl}/api/control/restart`, { method: 'POST' });
    assert.equal(
      restartControl.res.status,
      200,
      `Expected /api/control/restart 200, got ${restartControl.res.status}`,
    );
    assertControlSuccessShape(restartControl.payload, 'POST /api/control/restart');

    const reloadGate = createDeferred();
    runtimeControlMock.setGate('reload-config', reloadGate);

    const pendingReload = requestJson(`${baseUrl}/api/control/reload-config`, { method: 'POST' });
    await runtimeControlMock.waitForInFlight('reload-config', 1_500);

    const controlConflict = await requestJson(`${baseUrl}/api/control/restart`, { method: 'POST' });
    assert.equal(
      controlConflict.res.status,
      409,
      `Expected in-flight control conflict 409, got ${controlConflict.res.status}`,
    );
    assert.equal(
      typeof controlConflict.payload?.error,
      'string',
      'control conflict payload should include error string',
    );

    reloadGate.resolve();
    const pendingReloadResult = await pendingReload;
    assert.equal(
      pendingReloadResult.res.status,
      200,
      `Expected in-flight reload request to complete with 200, got ${pendingReloadResult.res.status}`,
    );
    assertControlSuccessShape(
      pendingReloadResult.payload,
      'POST /api/control/reload-config (pending completion)',
    );

    // Regression: close() must not hang when SSE clients are still connected.
    closeRegressionDashboard = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      rootDir,
      heartbeatMs: 100,
      broadcastDebounceMs: 20,
      runtimeManager: runtimeControlMock,
      runtime: runtimeControlMock,
      controlRuntime: runtimeControlMock,
    });
    const closeRegressionBaseUrl = `http://127.0.0.1:${closeRegressionDashboard.port}`;
    closeRegressionSse = await openSse(`${closeRegressionBaseUrl}/api/ui/events`);

    const closeResolved = await resolvesWithin(closeRegressionDashboard.close(), 1_500);
    assert.equal(closeResolved, true, 'dashboard.close() should resolve quickly with active SSE clients');

    console.log('test-dashboard-server: PASS');
  } finally {
    if (sse) await sse.close();
    if (dashboard) await dashboard.close();
    if (closeRegressionSse) await closeRegressionSse.close();
    if (closeRegressionDashboard) await closeRegressionDashboard.close();
    _resetOrderBoardForTests();
    globalThis.fetch = originalFetch;
    if (originalBotConfig === undefined) delete process.env.BOT_CONFIG;
    else process.env.BOT_CONFIG = originalBotConfig;
    if (originalBotConfigSchema === undefined) delete process.env.BOT_CONFIG_SCHEMA;
    else process.env.BOT_CONFIG_SCHEMA = originalBotConfigSchema;
    rmSync(configFixture.tempDir, { recursive: true, force: true });
  }
}

await run();
