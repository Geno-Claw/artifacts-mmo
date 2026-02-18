#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  _resetUiStateForTests,
  initializeUiState,
  recordLog,
} from '../src/services/ui-state.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';

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
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('SSE read timeout')), msRemaining);
      });

      const chunk = await Promise.race([readPromise, timeoutPromise]);
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

async function run() {
  _resetUiStateForTests();
  initializeUiState({
    characterNames: ['Alpha'],
    configPath: './config/characters.json',
    startedAt: 123,
  });

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
    assert.ok(Array.isArray(snapshot.characters));
    assert.equal(snapshot.characters.length, 1);

    const initialEvent = await sse.nextEvent(1_500);
    assert.equal(initialEvent.event, 'snapshot');
    assert.equal(initialEvent.data.characters.length, 1);

    recordLog('Alpha', {
      level: 'info',
      line: '[Alpha] test log line',
      at: Date.now(),
    });

    let mutationEvent = await sse.nextEvent(1_500);
    while (mutationEvent.event !== 'snapshot') {
      mutationEvent = await sse.nextEvent(1_500);
    }
    assert.equal(mutationEvent.data.characters[0].logLatest, '[Alpha] test log line');

    let heartbeatSeen = false;
    for (let i = 0; i < 10; i++) {
      const evt = await sse.nextEvent(1_500);
      if (evt.event === 'heartbeat') {
        heartbeatSeen = true;
        break;
      }
    }
    assert.equal(heartbeatSeen, true, 'Expected heartbeat SSE event');

    console.log('test-dashboard-server: PASS');
  } finally {
    await sse.close();
    await dashboard.close();
  }
}

await run();
