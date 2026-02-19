#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

process.env.ARTIFACTS_TOKEN ||= 'test-token';
process.env.ARTIFACTS_API ||= 'https://artifacts-api.test';

const uiState = await import('../src/services/ui-state.mjs');
const {
  _resetUiStateForTests,
  initializeUiState,
  recordCharacterSnapshot,
  recordLog,
} = uiState;
const { startDashboardServer } = await import('../src/dashboard-server.mjs');

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
  const title = getFirstPresent(entry, ['title', 'name', 'label']);
  assert.equal(typeof code, 'string', `${label} missing code/id`);
  assert.equal(typeof title, 'string', `${label} missing title/name`);

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

function createArtifactsApiMock(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const state = {
    detailsCalls: 0,
    achievementCalls: 0,
  };

  const summary = {
    account: 'qa-account',
    completed: 1,
    total: 2,
    inProgress: 1,
  };
  const achievements = [
    {
      code: 'first_steps',
      title: 'First Steps',
      completed: true,
      progress: 1,
      total: 1,
    },
    {
      code: 'ore_hoarder',
      title: 'Ore Hoarder',
      completed: false,
      progress: 12,
      total: 100,
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

      if (url.pathname.includes('/achievements')) {
        state.achievementCalls++;
        return createJsonResponse(200, { data: achievements });
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

async function run() {
  const originalFetch = globalThis.fetch;
  const apiMock = createArtifactsApiMock(process.env.ARTIFACTS_API || 'https://artifacts-api.test');
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

  const rootDir = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const dashboard = await startDashboardServer({
    host: '127.0.0.1',
    port: 0,
    rootDir,
    heartbeatMs: 100,
    broadcastDebounceMs: 20,
  });

  const baseUrl = `http://127.0.0.1:${dashboard.port}`;
  const sse = await openSse(`${baseUrl}/api/ui/events`);

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const snapshotRes = await fetch(`${baseUrl}/api/ui/snapshot`);
    assert.equal(snapshotRes.status, 200);
    const snapshot = await snapshotRes.json();
    assertSnapshotShape(snapshot);
    assert.equal(snapshot.characters.length, 1);
    assert.equal(snapshot.characters[0].name, 'Alpha');

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

    assert.ok(apiMock.state.detailsCalls >= 1, 'Expected account summary endpoint to call upstream details at least once');
    assert.ok(apiMock.state.achievementCalls >= 1, 'Expected account achievements endpoint to call upstream achievements at least once');

    console.log('test-dashboard-server: PASS');
  } finally {
    await sse.close();
    await dashboard.close();
    globalThis.fetch = originalFetch;
  }
}

await run();
