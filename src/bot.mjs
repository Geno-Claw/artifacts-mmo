#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'fs';
import { Scheduler } from './scheduler.mjs';
import { CharacterContext } from './context.mjs';
import { buildRoutines } from './routines/factory.mjs';
import * as log from './log.mjs';
import { initialize as initGameData } from './services/game-data.mjs';
import { initialize as initInventoryManager } from './services/inventory-manager.mjs';
import { loadSellRules } from './services/ge-seller.mjs';
import { createCharacter, subscribeActionEvents } from './api.mjs';
import { initializeUiState, recordCooldown, recordLog } from './services/ui-state.mjs';
import { startDashboardServer } from './dashboard-server.mjs';

const configPath = process.env.BOT_CONFIG || './config/characters.json';
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

if (!Array.isArray(config.characters)) {
  throw new Error(`Config "${configPath}" must include a top-level "characters" array`);
}

for (const [index, charCfg] of config.characters.entries()) {
  const label = charCfg?.name ? `character "${charCfg.name}"` : `character at index ${index}`;
  if (!Array.isArray(charCfg?.routines)) {
    if (Object.prototype.hasOwnProperty.call(charCfg ?? {}, 'tasks')) {
      throw new Error(`Config error for ${label}: "tasks" was removed, use "routines"`);
    }
    throw new Error(`Config error for ${label}: missing required "routines" array`);
  }
}

const configuredNames = config.characters.map(c => c.name).filter(Boolean);
const configuredNameSet = new Set(configuredNames);

initializeUiState({
  characterNames: configuredNames,
  configPath,
  startedAt: Date.now(),
});

const unsubscribeLogEvents = log.subscribeLogEvents((entry) => {
  const match = entry.msg.match(/^\[([^\]]+)\]/);
  if (!match) return;
  const name = match[1];
  if (!configuredNameSet.has(name)) return;
  recordLog(name, {
    level: entry.level,
    line: entry.msg,
    at: entry.at,
  });
});

const unsubscribeActionEvents = subscribeActionEvents((entry) => {
  if (!configuredNameSet.has(entry.name)) return;
  const cooldown = entry.cooldown || {};
  recordCooldown(entry.name, {
    action: entry.action,
    totalSeconds: cooldown.total_seconds ?? cooldown.remaining_seconds ?? 0,
    remainingSeconds: cooldown.remaining_seconds ?? cooldown.total_seconds ?? 0,
    observedAt: entry.observedAt,
  });
});

const dashboard = await startDashboardServer();

log.info(`Bot starting — ${config.characters.length} character(s)`);

await initGameData();
await initInventoryManager();
loadSellRules();

const loops = config.characters.map(async (charCfg) => {
  const ctx = new CharacterContext(charCfg.name, charCfg.settings || {});
  const routines = buildRoutines(charCfg.routines);

  try {
    await ctx.refresh();
  } catch (err) {
    if (err.code === 404 || err.code === 498) {
      const skin = charCfg.skin || 'men1';
      log.info(`[${charCfg.name}] Character not found — creating with skin "${skin}"`);
      await createCharacter(charCfg.name, skin);
      await ctx.refresh();
    } else {
      throw err;
    }
  }

  const char = ctx.get();
  log.info(`[${char.name}] Lv${char.level} | ${char.hp}/${char.max_hp} HP | ${char.gold}g | (${char.x},${char.y})`);

  const scheduler = new Scheduler(ctx, routines);
  return scheduler.run();
});

process.on('SIGINT', () => {
  log.info('Shutting down');
  unsubscribeActionEvents();
  unsubscribeLogEvents();

  const forceExitTimer = setTimeout(() => process.exit(0), 1_000);
  forceExitTimer.unref();

  dashboard.close().finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
});

await Promise.all(loops);
