#!/usr/bin/env node
import 'dotenv/config';
import { Scheduler } from './scheduler.mjs';
import * as state from './state.mjs';
import * as log from './log.mjs';
import { defaultTasks } from './tasks/index.mjs';
import { CHARACTER } from './api.mjs';

log.info(`Bot starting — character: ${CHARACTER}`);

const char = await state.refresh();
log.info(`${char.name} | Lv${char.level} | ${char.hp}/${char.max_hp} HP | ${char.gold}g | (${char.x},${char.y})`);

const scheduler = new Scheduler(defaultTasks());

process.on('SIGINT', () => {
  log.info('Shutting down');
  process.exit(0);
});

await scheduler.run();
