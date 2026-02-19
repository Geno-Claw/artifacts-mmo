#!/usr/bin/env node
import 'dotenv/config';
import * as log from './log.mjs';
import { createRuntimeManager } from './runtime-manager.mjs';
import { startDashboardServer } from './dashboard-server.mjs';

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

const stopTimeoutMs = toPositiveInt(process.env.RUNTIME_STOP_TIMEOUT_MS, 120_000);

const runtimeManager = createRuntimeManager({
  defaultStopTimeoutMs: stopTimeoutMs,
});

const dashboard = await startDashboardServer({
  runtimeManager,
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Shutting down (${signal})`);

  const forceExitTimer = setTimeout(() => {
    process.exit(1);
  }, stopTimeoutMs + 1_000);
  forceExitTimer.unref();

  try {
    await runtimeManager.stop(stopTimeoutMs);
  } catch (err) {
    log.error('Graceful runtime stop failed', err?.message || String(err));
  }

  try {
    await dashboard.close();
  } catch (err) {
    log.error('Dashboard shutdown failed', err?.message || String(err));
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await runtimeManager.start();
} catch (err) {
  log.error('Bot startup failed', err?.message || String(err));
  await dashboard.close().catch(() => {
    // No-op
  });
  throw err;
}
