#!/usr/bin/env node
/**
 * Validate local combat simulator against the server-side simulation API.
 *
 * For a selection of monsters (covering various effects), this script:
 * 1. Calls the API simulation endpoint (100 iterations each)
 * 2. Runs our local deterministic simulator
 * 3. Compares win/loss, turns, and remaining HP
 * 4. Parses API fight logs to verify exact turn-by-turn mechanics
 *
 * Usage: node scripts/validate-combat-sim.mjs
 *   Requires ARTIFACTS_TOKEN in .env (member/founder account for simulation API).
 */
import 'dotenv/config';
import * as api from '../src/api.mjs';
import { simulateCombat, calcTurnDamage } from '../src/services/combat-simulator.mjs';

// ─── Config ────────────────────────────────────────────────────────
const ITERATIONS = 100;

// ─── API helpers ───────────────────────────────────────────────────

async function fetchAllMonsters() {
  const all = [];
  let page = 1;
  while (true) {
    const result = await api.getMonsters({ page, size: 100 });
    const monsters = Array.isArray(result) ? result : [];
    if (monsters.length === 0) break;
    all.push(...monsters);
    if (monsters.length < 100) break;
    page++;
  }
  return all;
}

async function fetchAllItems() {
  const map = new Map();
  let page = 1;
  while (true) {
    const result = await api.getItems({ page, size: 100 });
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) break;
    for (const item of items) map.set(item.code, item);
    if (items.length < 100) break;
    page++;
  }
  return map;
}

async function fetchCharacters() {
  const chars = await api.getMyCharacters();
  return Array.isArray(chars) ? chars : [];
}

// ─── Fake character builder (mirrors event-simulation.mjs) ────────

const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor', 'leg_armor', 'boots',
  'ring1', 'ring2', 'amulet', 'artifact1', 'artifact2', 'artifact3',
  'utility1', 'utility2', 'rune',
];

function buildFakeCharacter(char) {
  const fake = { level: char.level };
  for (const slot of EQUIPMENT_SLOTS) {
    const code = char[`${slot}_slot`] || null;
    if (code) fake[`${slot}_slot`] = code;
  }
  if (char.utility1_slot) fake.utility1_slot_quantity = char.utility1_slot_quantity || 1;
  if (char.utility2_slot) fake.utility2_slot_quantity = char.utility2_slot_quantity || 1;
  return fake;
}

// ─── Build local sim options from character equipment ──────────────

function buildSimOptions(char, itemsMap) {
  const options = {};

  // Utilities
  const utilities = [];
  for (const slot of ['utility1', 'utility2']) {
    const code = char[`${slot}_slot`];
    if (code) {
      const item = itemsMap.get(code);
      if (item) utilities.push({ code, effects: item.effects || [] });
    }
  }
  if (utilities.length > 0) options.utilities = utilities;

  // Rune
  const runeCode = char.rune_slot;
  if (runeCode) {
    const item = itemsMap.get(runeCode);
    if (item) options.rune = { code: runeCode, effects: item.effects || [] };
  }

  return options;
}

// ─── Select test monsters covering different effects ──────────────

function selectTestMonsters(allMonsters, charLevel) {
  // Group ALL monsters by effect type (no level filter — we want coverage)
  const effectMap = new Map(); // effectCode → [monsters]
  const noEffects = [];

  for (const m of allMonsters) {
    const effects = m.effects || [];
    if (effects.length === 0) {
      noEffects.push(m);
    } else {
      for (const e of effects) {
        if (!effectMap.has(e.code)) effectMap.set(e.code, []);
        effectMap.get(e.code).push(m);
      }
    }
  }

  const selected = new Map(); // code → monster (deduplicated)

  // Pick 1 no-effect monster near char level (baseline)
  noEffects.sort((a, b) => Math.abs(a.level - charLevel) - Math.abs(b.level - charLevel));
  if (noEffects.length > 0) selected.set(noEffects[0].code, noEffects[0]);

  // Pick 1 monster per effect type (prefer lowest level for longer, more observable fights)
  for (const [effectCode, monsters] of effectMap) {
    monsters.sort((a, b) => a.level - b.level);
    const pick = monsters[0];
    if (pick && !selected.has(pick.code)) {
      selected.set(pick.code, pick);
    }
  }

  return [...selected.values()];
}

// ─── Fight log parsing ─────────────────────────────────────────────

/**
 * Parse API fight logs to extract turn-by-turn events.
 * Log format varies but typically includes structured messages about
 * damage, healing, effects, etc.
 */
function parseFightLogs(logs) {
  const events = [];
  let currentTurn = 0;

  for (const line of logs) {
    // Try to detect turn markers
    const turnMatch = line.match(/turn\s*(\d+)/i);
    if (turnMatch) currentTurn = parseInt(turnMatch[1]);

    events.push({ turn: currentTurn, text: line });
  }

  return events;
}

/**
 * Extract key observations from fight logs for mechanic validation.
 */
function analyzeLogs(logs) {
  const analysis = {
    totalTurns: 0,
    damageEvents: [],
    healingEvents: [],
    effectTriggers: [],
    barrierEvents: [],
    burnTicks: [],
    poisonTicks: [],
    voidDrainTicks: [],
    corruptedTicks: [],
    restoreTriggers: [],
    rawLogs: logs,
  };

  let turn = 0;
  for (const line of logs) {
    const turnMatch = line.match(/turn\s*(\d+)/i);
    if (turnMatch) {
      turn = parseInt(turnMatch[1]);
      analysis.totalTurns = Math.max(analysis.totalTurns, turn);
    }

    // Damage events
    const dmgMatch = line.match(/(\d+)\s*(fire|earth|water|air)?\s*damage/i);
    if (dmgMatch) {
      analysis.damageEvents.push({ turn, amount: parseInt(dmgMatch[1]), element: dmgMatch[2] || '', text: line });
    }

    // Healing
    if (/heal|restore|recover/i.test(line)) {
      const healMatch = line.match(/(\d+)\s*(?:hp|health|heal)/i);
      analysis.healingEvents.push({ turn, amount: healMatch ? parseInt(healMatch[1]) : 0, text: line });
    }

    // Barrier
    if (/barrier/i.test(line)) {
      analysis.barrierEvents.push({ turn, text: line });
    }

    // Burn
    if (/burn/i.test(line)) {
      const burnMatch = line.match(/(\d+)/);
      analysis.burnTicks.push({ turn, amount: burnMatch ? parseInt(burnMatch[1]) : 0, text: line });
    }

    // Poison
    if (/poison/i.test(line)) {
      analysis.poisonTicks.push({ turn, text: line });
    }

    // Void drain
    if (/void.?drain|drain/i.test(line)) {
      analysis.voidDrainTicks.push({ turn, text: line });
    }

    // Corrupted
    if (/corrupt/i.test(line)) {
      analysis.corruptedTicks.push({ turn, text: line });
    }

    // Restore utility
    if (/restore/i.test(line)) {
      analysis.restoreTriggers.push({ turn, text: line });
    }
  }

  return analysis;
}

// ─── Comparison logic ──────────────────────────────────────────────

function compareResults(monsterCode, monsterEffects, localResult, apiData) {
  const issues = [];
  const info = [];

  // Win rate comparison
  const localWin = localResult.win;
  const apiWinrate = apiData.winrate;

  if (localWin && apiWinrate < 30) {
    issues.push(`WIN MISMATCH: Local predicts WIN but API winrate is ${apiWinrate}%`);
  } else if (!localWin && apiWinrate > 70) {
    issues.push(`WIN MISMATCH: Local predicts LOSS but API winrate is ${apiWinrate}%`);
  } else {
    info.push(`Win agreement: local=${localWin ? 'WIN' : 'LOSS'}, API=${apiWinrate}%`);
  }

  // Turn count comparison — both use 1 turn = 1 entity attacks (alternating)
  if (apiData.results?.length > 0) {
    const apiAvgTurns = apiData.results.reduce((s, r) => s + r.turns, 0) / apiData.results.length;
    const turnDiff = Math.abs(localResult.turns - apiAvgTurns);
    const turnPct = apiAvgTurns > 0 ? (turnDiff / apiAvgTurns) * 100 : 0;

    if (turnPct > 25) {
      issues.push(`TURN MISMATCH: Local=${localResult.turns}, API avg=${apiAvgTurns.toFixed(1)} (${turnPct.toFixed(0)}% diff)`);
    } else {
      info.push(`Turns: local=${localResult.turns}, API avg=${apiAvgTurns.toFixed(1)} (${turnPct.toFixed(0)}% diff)`);
    }

    // HP remaining comparison (for wins only)
    const apiWins = apiData.results.filter(r => r.result === 'win');
    if (apiWins.length > 0 && localWin) {
      // Extract final_hp from character_results
      const apiAvgHp = apiWins.reduce((s, r) => {
        const charResult = r.character_results?.[0];
        return s + (charResult?.final_hp ?? 0);
      }, 0) / apiWins.length;

      const hpDiff = Math.abs(localResult.remainingHp - apiAvgHp);
      info.push(`HP remaining: local=${localResult.remainingHp}, API avg=${apiAvgHp.toFixed(0)} (diff=${hpDiff.toFixed(0)})`);
    }
  }

  return { issues, info };
}

// ─── Log analysis for specific mechanic validation ─────────────────

function validateMechanics(monster, apiResult) {
  const findings = [];
  const effects = (monster.effects || []).map(e => e.code);

  // Pick one fight result with logs to analyze
  const sampleFight = apiResult.results?.[0];
  if (!sampleFight?.logs?.length) {
    findings.push('  (no fight logs available for mechanic validation)');
    return findings;
  }

  const analysis = analyzeLogs(sampleFight.logs);

  // Report raw log sample
  findings.push(`  Log sample (${sampleFight.logs.length} lines, fight=${sampleFight.result} in ${sampleFight.turns} API-turns):`);

  // For effect monsters, show all lines (they're the interesting ones)
  const logLines = sampleFight.logs;
  const hasEffects = effects.length > 0;
  const preview = hasEffects || logLines.length <= 30
    ? logLines
    : [...logLines.slice(0, 6), `  ... (${logLines.length - 12} more lines) ...`, ...logLines.slice(-6)];
  for (const line of preview) {
    findings.push(`    ${line}`);
  }

  // Check void drain timing (key suspect)
  if (effects.includes('void_drain') && analysis.voidDrainTicks.length > 0) {
    const drainTurns = analysis.voidDrainTicks.map(e => e.turn);
    findings.push(`  VOID DRAIN triggers at turns: [${drainTurns.join(', ')}]`);
    findings.push(`    Our code fires at: 5, 9, 13, 17... ((turn-1) % 4 === 0, turn > 1)`);
    findings.push(`    Expected if off-by-one: 4, 8, 12, 16... (turn % 4 === 0)`);
  }

  // Check barrier timing
  if (effects.includes('barrier') && analysis.barrierEvents.length > 0) {
    const barrierTurns = analysis.barrierEvents.map(e => e.turn);
    findings.push(`  BARRIER events at turns: [${barrierTurns.join(', ')}]`);
    findings.push(`    Our code: start + refresh at 6, 11, 16...`);
  }

  // Check healing timing
  if (effects.includes('healing') && analysis.healingEvents.length > 0) {
    const healTurns = analysis.healingEvents.map(e => e.turn);
    findings.push(`  HEALING events at turns: [${healTurns.join(', ')}]`);
    findings.push(`    Our code fires at: 4, 7, 10, 13...`);
  }

  // Check burn damage decay
  if (effects.includes('burn') && analysis.burnTicks.length > 0) {
    const burnAmounts = analysis.burnTicks.map(e => `t${e.turn}:${e.amount}`);
    findings.push(`  BURN ticks: [${burnAmounts.join(', ')}]`);
    findings.push(`    Should decay 10% each turn`);
  }

  // Check corrupted
  if (effects.includes('corrupted') && analysis.corruptedTicks.length > 0) {
    findings.push(`  CORRUPTED events: ${analysis.corruptedTicks.length} total`);
    for (const e of analysis.corruptedTicks.slice(0, 3)) {
      findings.push(`    t${e.turn}: ${e.text}`);
    }
  }

  return findings;
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== Combat Simulator Validation ===\n');
  console.log('Loading game data...');

  const [allMonsters, itemsMap, characters] = await Promise.all([
    fetchAllMonsters(),
    fetchAllItems(),
    fetchCharacters(),
  ]);

  console.log(`Loaded ${allMonsters.length} monsters, ${itemsMap.size} items, ${characters.length} characters\n`);

  if (characters.length === 0) {
    console.error('No characters found. Check your ARTIFACTS_TOKEN.');
    process.exit(1);
  }

  // Use the highest-level character for testing
  const char = characters.sort((a, b) => b.level - a.level)[0];
  console.log(`Using character: ${char.name} (level ${char.level})`);
  console.log(`  HP: ${char.hp}/${char.max_hp}`);
  console.log(`  Attack: fire=${char.attack_fire} earth=${char.attack_earth} water=${char.attack_water} air=${char.attack_air}`);
  console.log(`  Dmg: ${char.dmg}% | Crit: ${char.critical_strike}% | Init: ${char.initiative}`);
  console.log(`  Res: fire=${char.res_fire}% earth=${char.res_earth}% water=${char.res_water}% air=${char.res_air}%`);
  console.log();

  // Select monsters to test
  const testMonsters = selectTestMonsters(allMonsters, char.level);
  console.log(`Selected ${testMonsters.length} test monsters:\n`);

  for (const m of testMonsters) {
    const effectCodes = (m.effects || []).map(e => `${e.code}(${e.value})`).join(', ') || 'none';
    console.log(`  ${m.code} (lv${m.level}) — effects: ${effectCodes}`);
  }
  console.log();

  // Build fake character for API simulation
  const fakeChar = buildFakeCharacter(char);
  const simOptions = buildSimOptions(char, itemsMap);

  // Also build a high-level naked character for timing tests against effect monsters
  // Level 40 with no gear = just base stats, enough HP to survive several turns
  const nakedFakeChar = { level: 40 };

  let totalTests = 0;
  let totalIssues = 0;

  for (const monster of testMonsters) {
    totalTests++;
    const effectCodes = (monster.effects || []).map(e => `${e.code}(${e.value})`).join(', ') || 'none';
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Monster: ${monster.code} (lv${monster.level}) — effects: ${effectCodes}`);
    console.log(`  HP: ${monster.hp} | Attack: fire=${monster.attack_fire} earth=${monster.attack_earth} water=${monster.attack_water} air=${monster.attack_air}`);
    console.log(`  Res: fire=${monster.res_fire}% earth=${monster.res_earth}% water=${monster.res_water}% air=${monster.res_air}% | Crit: ${monster.critical_strike}% | Init: ${monster.initiative}`);

    // Run local simulation
    const localResult = simulateCombat(char, monster, simOptions);
    const charDmg = calcTurnDamage(char, monster);
    const monDmg = calcTurnDamage(monster, char);
    console.log(`\n  LOCAL SIM: ${localResult.win ? 'WIN' : 'LOSS'} in ${localResult.turns} turns, ${localResult.remainingHp} HP left (${localResult.hpLostPercent.toFixed(1)}% lost)`);
    console.log(`    Char dmg/turn: ${charDmg}, Monster dmg/turn: ${monDmg}`);

    // Run API simulation
    let apiData;
    try {
      apiData = await api.simulateFight({
        characters: [fakeChar],
        monster: monster.code,
        iterations: ITERATIONS,
      });
    } catch (err) {
      console.log(`  API SIM: FAILED — ${err.message}`);
      console.log('  (Simulation API may require member/founder account)');
      continue;
    }

    const apiAvgTurns = apiData.results?.length > 0
      ? apiData.results.reduce((s, r) => s + r.turns, 0) / apiData.results.length
      : 0;
    console.log(`  API SIM:   ${apiData.winrate}% winrate (${apiData.wins}W/${apiData.losses}L), avg ${apiAvgTurns.toFixed(1)} turns (${ITERATIONS} iters)`);

    // Compare
    const { issues, info } = compareResults(monster.code, monster.effects, localResult, apiData);
    for (const msg of info) console.log(`  ✓ ${msg}`);
    for (const msg of issues) {
      console.log(`  ✗ ${msg}`);
      totalIssues++;
    }

    // Analyze fight logs for mechanic validation
    const mechanicFindings = validateMechanics(monster, apiData);
    if (mechanicFindings.length > 0) {
      console.log('\n  Mechanic validation:');
      for (const f of mechanicFindings) console.log(f);
    }

    // Small delay to avoid rate-limiting
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Part 2: Timing-focused tests with naked high-level char ──────
  // Use a naked level 50 character (high HP, low attack) to get LONG fights
  // that reveal effect timing patterns.
  console.log(`\n${'═'.repeat(70)}`);
  console.log('PART 2: Effect Timing Tests (naked lv50 char for long fights)\n');

  const timingMonsters = testMonsters.filter(m => (m.effects || []).length > 0);

  for (const monster of timingMonsters) {
    const effectCodes = (monster.effects || []).map(e => `${e.code}(${e.value})`).join(', ');
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`TIMING TEST: ${monster.code} (lv${monster.level}) — ${effectCodes}`);

    let apiData;
    try {
      apiData = await api.simulateFight({
        characters: [nakedFakeChar],
        monster: monster.code,
        iterations: 1, // just 1 for log analysis
      });
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
      continue;
    }

    const fight = apiData.results?.[0];
    if (!fight?.logs?.length) {
      console.log('  No logs available');
      continue;
    }

    console.log(`  Result: ${fight.result} in ${fight.turns} API-turns (${fight.logs.length} log lines)`);
    console.log();

    // Print ALL log lines for effect monsters — this is the key data
    for (const line of fight.logs) {
      console.log(`    ${line}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`SUMMARY: ${totalTests} monsters tested, ${totalIssues} issues found`);
  if (totalIssues === 0) {
    console.log('All local predictions align with API simulation results!');
  } else {
    console.log('Review the issues above for potential simulator fixes.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
