#!/usr/bin/env node
/**
 * CLI for Artifacts MMO sandbox server operations.
 *
 * Usage:
 *   node scripts/sandbox.mjs give-gold <character> <quantity>
 *   node scripts/sandbox.mjs give-item <character> <code> <quantity>
 *   node scripts/sandbox.mjs give-xp <character> <type> <amount>
 *   node scripts/sandbox.mjs spawn-event <code>
 *   node scripts/sandbox.mjs reset-account
 */
import {
  isSandbox,
  sandboxGiveGold,
  sandboxGiveItem,
  sandboxGiveXp,
  sandboxSpawnEvent,
  sandboxResetAccount,
  API,
} from '../src/api.mjs';

const XP_TYPES = [
  'combat', 'weaponcrafting', 'gearcrafting', 'jewelrycrafting',
  'cooking', 'woodcutting', 'mining', 'alchemy', 'fishing',
];

function usage() {
  console.log(`
Artifacts MMO Sandbox CLI
Connected to: ${API}

Commands:
  give-gold   <character> <quantity>           Give gold to a character
  give-item   <character> <code> <quantity>    Give an item to a character
  give-xp     <character> <type> <amount>      Give XP to a character
  spawn-event <code>                           Spawn an event
  reset-account                                Reset entire account

XP types: ${XP_TYPES.join(', ')}

Examples:
  node scripts/sandbox.mjs give-gold MyChar 10000
  node scripts/sandbox.mjs give-item MyChar copper_ore 100
  node scripts/sandbox.mjs give-xp MyChar mining 50000
  node scripts/sandbox.mjs spawn-event bandit_camp
  node scripts/sandbox.mjs reset-account
`.trim());
}

const [,, command, ...args] = process.argv;

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

if (!isSandbox()) {
  console.error(`ERROR: Not connected to sandbox server.`);
  console.error(`Current API: ${API}`);
  console.error(`Set ARTIFACTS_API=https://api.sandbox.artifactsmmo.com in .env`);
  process.exit(1);
}

try {
  switch (command) {
    case 'give-gold': {
      const [character, qty] = args;
      if (!character || !qty) { console.error('Usage: give-gold <character> <quantity>'); process.exit(1); }
      const result = await sandboxGiveGold(character, Number(qty));
      console.log(`Gave ${qty} gold to ${character}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'give-item': {
      const [character, code, qty] = args;
      if (!character || !code || !qty) { console.error('Usage: give-item <character> <code> <quantity>'); process.exit(1); }
      const result = await sandboxGiveItem(character, code, Number(qty));
      console.log(`Gave ${qty}x ${code} to ${character}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'give-xp': {
      const [character, type, amount] = args;
      if (!character || !type || !amount) { console.error('Usage: give-xp <character> <type> <amount>'); process.exit(1); }
      if (!XP_TYPES.includes(type)) {
        console.error(`Invalid XP type: ${type}`);
        console.error(`Valid types: ${XP_TYPES.join(', ')}`);
        process.exit(1);
      }
      const result = await sandboxGiveXp(character, type, Number(amount));
      console.log(`Gave ${amount} ${type} XP to ${character}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'spawn-event': {
      const [code] = args;
      if (!code) { console.error('Usage: spawn-event <code>'); process.exit(1); }
      const result = await sandboxSpawnEvent(code);
      console.log(`Spawned event: ${code}`);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'reset-account': {
      const result = await sandboxResetAccount();
      console.log('Account reset successfully');
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (err.code) console.error(`Code: ${err.code}`);
  process.exit(1);
}
