#!/usr/bin/env node
/**
 * Artifacts MMO grinding loop
 * Usage: node grind.mjs [--target chicken] [--rounds 10] [--rest-threshold 30]
 * 
 * Fights monsters, rests when HP low, reports progress.
 * Run from ~/artifacts-mmo directory.
 */
import { move, fight, rest, gather, getCharacter, waitForCooldown, CHARACTER } from './api.mjs';
import { parseArgs } from 'node:util';

// Monster locations (overworld)
const MONSTER_LOCATIONS = {
  chicken: [0, 1], cow: [0, 2], wolf: [-3, 0],
  pig: [-3, -3], blue_slime: [0, -2], yellow_slime: [1, -2],
  red_slime: [2, -2], green_slime: [3, -2], mushmush: [5, 3],
  goblin: [6, -2], sheep: [5, 12], spider: [-3, 12],
};

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'chicken' },
    rounds: { type: 'string', default: '10' },
    'rest-threshold': { type: 'string', default: '30' },
  }
});

const target = values.target;
const maxRounds = parseInt(values.rounds, 10);
const restThreshold = parseInt(values['rest-threshold'], 10);

const loc = MONSTER_LOCATIONS[target];
if (!loc) {
  console.error(`Unknown monster: ${target}. Available: ${Object.keys(MONSTER_LOCATIONS).join(', ')}`);
  process.exit(1);
}

console.log(`🎮 Grinding ${target} at (${loc[0]},${loc[1]}) for ${maxRounds} rounds`);
console.log(`   Rest when HP < ${restThreshold}%\n`);

// Check current position
const char = await getCharacter();
if (char.x !== loc[0] || char.y !== loc[1]) {
  console.log(`🚶 Moving from (${char.x},${char.y}) to (${loc[0]},${loc[1]})...`);
  const moveResult = await move(loc[0], loc[1]);
  await waitForCooldown(moveResult);
}

let totalXP = 0, totalGold = 0, wins = 0, losses = 0;
const drops = {};

for (let round = 1; round <= maxRounds; round++) {
  // Check HP
  const status = await getCharacter();
  const hpPct = (status.hp / status.max_hp) * 100;
  
  if (hpPct < restThreshold) {
    console.log(`💤 Resting (${status.hp}/${status.max_hp} HP)...`);
    const restResult = await rest();
    await waitForCooldown(restResult);
    console.log(`   HP restored to ${(await getCharacter()).hp}/${status.max_hp}`);
  }

  // Fight
  process.stdout.write(`⚔️  Round ${round}/${maxRounds}: `);
  try {
    const result = await fight();
    const f = result.fight;
    
    if (f.result === 'win') {
      wins++;
      // XP/gold/drops are per-character in fight.characters[]
      const charResult = f.characters?.find(c => c.character_name === CHARACTER) || f.characters?.[0] || {};
      const xp = charResult.xp || 0;
      const gold = charResult.gold || 0;
      totalXP += xp;
      totalGold += gold;
      
      const dropStr = charResult.drops?.length 
        ? charResult.drops.map(d => { drops[d.code] = (drops[d.code] || 0) + d.quantity; return `${d.code}×${d.quantity}`; }).join(', ')
        : '';
      
      console.log(`WIN in ${f.turns} turns | +${xp} XP +${gold}g${dropStr ? ' | ' + dropStr : ''} (${charResult.final_hp} HP left)`);
    } else {
      losses++;
      console.log(`LOSS in ${f.turns} turns`);
    }
    
    await waitForCooldown(result);
  } catch (err) {
    if (err.code === 499) {
      console.log(`⏳ Cooldown: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
      round--; // retry
      continue;
    }
    throw err;
  }
}

// Summary
console.log(`\n📊 Session Complete`);
console.log(`   Wins: ${wins} | Losses: ${losses}`);
console.log(`   XP: +${totalXP} | Gold: +${totalGold}`);
if (Object.keys(drops).length) {
  console.log(`   Drops: ${Object.entries(drops).map(([k,v]) => `${k}×${v}`).join(', ')}`);
}
const final = await getCharacter();
console.log(`   Level: ${final.level} (${final.xp}/${final.max_xp} XP)`);
console.log(`   HP: ${final.hp}/${final.max_hp} | Gold: ${final.gold}`);
