#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'fs';
import { Scheduler } from './scheduler.mjs';
import { CharacterContext } from './context.mjs';
import { buildTasks } from './tasks/factory.mjs';
import * as log from './log.mjs';

const config = JSON.parse(readFileSync('./config/characters.json', 'utf-8'));

log.info(`Bot starting — ${config.characters.length} character(s)`);

const loops = config.characters.map(async (charCfg) => {
  const ctx = new CharacterContext(charCfg.name);
  const tasks = buildTasks(charCfg.tasks);
  const char = await ctx.refresh();
  log.info(`[${char.name}] Lv${char.level} | ${char.hp}/${char.max_hp} HP | ${char.gold}g | (${char.x},${char.y})`);

  const scheduler = new Scheduler(ctx, tasks);
  return scheduler.run();
});

process.on('SIGINT', () => {
  log.info('Shutting down');
  process.exit(0);
});

await Promise.all(loops);
