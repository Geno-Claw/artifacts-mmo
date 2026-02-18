#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'fs';
import { Scheduler } from './scheduler.mjs';
import { CharacterContext } from './context.mjs';
import { buildRoutines } from './routines/factory.mjs';
import * as log from './log.mjs';
import { initialize as initGameData } from './services/game-data.mjs';
import { loadSellRules } from './services/ge-seller.mjs';
import { createCharacter } from './api.mjs';

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

log.info(`Bot starting — ${config.characters.length} character(s)`);

await initGameData();
loadSellRules();

const loops = config.characters.map(async (charCfg) => {
  const ctx = new CharacterContext(charCfg.name);
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
  process.exit(0);
});

await Promise.all(loops);
