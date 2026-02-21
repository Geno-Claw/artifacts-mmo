#!/usr/bin/env node
/**
 * WebSocket listener — captures account_log events and groups by type.
 * Run: node scripts/ws-listener.mjs
 * Press Ctrl+C to print a summary of all types seen and their content keys.
 */
import 'dotenv/config';
import {
  initialize,
  subscribe,
  cleanup,
} from '../src/services/websocket-client.mjs';

const TOKEN = process.env.ARTIFACTS_TOKEN;
const WS_URL = process.env.WEBSOCKET_URL;

if (!TOKEN || !WS_URL) {
  console.error('ARTIFACTS_TOKEN and WEBSOCKET_URL required in .env');
  process.exit(1);
}

/** @type {Map<string, { count: number, contentKeys: Set<string>, lastDescription: string }>} */
const typeStats = new Map();
let totalEvents = 0;

subscribe('account_log', (data) => {
  totalEvents++;
  const type = data.type || 'unknown';
  const contentKeys = data.content ? Object.keys(data.content) : [];

  let stats = typeStats.get(type);
  if (!stats) {
    stats = { count: 0, contentKeys: new Set(), lastDescription: '' };
    typeStats.set(type, stats);
  }
  stats.count++;
  for (const key of contentKeys) stats.contentKeys.add(key);
  stats.lastDescription = data.description || '';

  // Live output
  const time = data.created_at
    ? new Date(data.created_at).toLocaleTimeString()
    : '??:??:??';
  console.log(`[${time}] [${type}] ${data.character}: ${data.description}`);
  console.log(`  content keys: [${contentKeys.join(', ')}]`);
  console.log();
});

function printSummary() {
  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY — ${totalEvents} total events, ${typeStats.size} unique types`);
  console.log('='.repeat(70));

  for (const [type, stats] of [...typeStats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n  ${type} (${stats.count}x)`);
    console.log(`    content keys: [${[...stats.contentKeys].join(', ')}]`);
    console.log(`    last: ${stats.lastDescription.slice(0, 120)}`);
  }
  console.log();
}

process.on('SIGINT', async () => {
  printSummary();
  await cleanup();
  process.exit(0);
});

async function main() {
  console.log(`Connecting to ${WS_URL}...`);
  await initialize({ url: WS_URL, token: TOKEN });
  console.log('Connected. Listening for account_log events. Press Ctrl+C for summary.\n');

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
