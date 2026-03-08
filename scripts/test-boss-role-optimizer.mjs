/**
 * Tests for role-based boss fight gear optimization.
 *
 * Covers:
 *  - isBetterTankResult / isBetterDpsResult comparison functions
 *  - optimizeForRole() selecting correct gear per role
 */
import assert from 'node:assert/strict';
import {
  isBetterTankResult,
  isTankResultTie,
  isBetterDpsResult,
  isDpsResultTie,
} from '../src/services/combat-simulator.mjs';
import {
  optimizeForRole,
  getCandidatesForSlot,
  _setDepsForTests,
  _resetDepsForTests,
} from '../src/services/gear-optimizer.mjs';

// ============================================================
// isBetterTankResult tests
// ============================================================

console.log('--- isBetterTankResult ---');

console.log('Test: a with threat beats b without threat, even if b survives longer');
{
  const a = { avgTurns: 30, winRate: 0, avgRemainingHp: 0 };
  const b = { avgTurns: 50, winRate: 50, avgRemainingHp: 100 };
  assert.ok(isBetterTankResult(a, b, 5, 0));
  assert.ok(!isBetterTankResult(b, a, 0, 5));
}
console.log('  PASS');

console.log('Test: both have threat → higher winRate wins (even if fewer turns)');
{
  const a = { avgTurns: 30, winRate: 80, avgRemainingHp: 100 };
  const b = { avgTurns: 60, winRate: 50, avgRemainingHp: 100 };
  assert.ok(isBetterTankResult(a, b, 5, 5));
  assert.ok(!isBetterTankResult(b, a, 5, 5));
}
console.log('  PASS');

console.log('Test: same winRate → higher remaining HP wins');
{
  const a = { avgTurns: 50, winRate: 80, avgRemainingHp: 200 };
  const b = { avgTurns: 50, winRate: 80, avgRemainingHp: 100 };
  assert.ok(isBetterTankResult(a, b, 5, 5));
}
console.log('  PASS');

console.log('Test: same winRate, same HP → higher turns wins (losing tiebreaker)');
{
  const a = { avgTurns: 60, winRate: 0, avgRemainingHp: 0 };
  const b = { avgTurns: 40, winRate: 0, avgRemainingHp: 0 };
  assert.ok(isBetterTankResult(a, b, 5, 5));
}
console.log('  PASS');

console.log('Test: same survivability → more threat wins');
{
  const a = { avgTurns: 50, winRate: 80, avgRemainingHp: 100 };
  const b = { avgTurns: 50, winRate: 80, avgRemainingHp: 100 };
  assert.ok(isBetterTankResult(a, b, 10, 5));
  assert.ok(!isBetterTankResult(b, a, 5, 10));
}
console.log('  PASS');

console.log('Test: neither has threat → higher winRate wins');
{
  const a = { avgTurns: 60, winRate: 50, avgRemainingHp: 100 };
  const b = { avgTurns: 40, winRate: 80, avgRemainingHp: 200 };
  assert.ok(isBetterTankResult(b, a, 0, 0));
  assert.ok(!isBetterTankResult(a, b, 0, 0));
}
console.log('  PASS');

console.log('Test: null handling');
{
  const a = { avgTurns: 50, winRate: 80, avgRemainingHp: 100 };
  assert.ok(isBetterTankResult(a, null, 5, 0));
  assert.ok(!isBetterTankResult(null, a, 0, 5));
}
console.log('  PASS');

// ============================================================
// isTankResultTie tests
// ============================================================

console.log('\n--- isTankResultTie ---');

console.log('Test: same survivability and same threat → tie');
{
  const a = { avgTurns: 50, avgRemainingHp: 100 };
  const b = { avgTurns: 50, avgRemainingHp: 100 };
  assert.ok(isTankResultTie(a, b, 5, 5));
}
console.log('  PASS');

console.log('Test: different threat → not a tie');
{
  const a = { avgTurns: 50, avgRemainingHp: 100 };
  const b = { avgTurns: 50, avgRemainingHp: 100 };
  assert.ok(!isTankResultTie(a, b, 5, 0));
}
console.log('  PASS');

console.log('Test: different turns → not a tie');
{
  const a = { avgTurns: 50, avgRemainingHp: 100 };
  const b = { avgTurns: 40, avgRemainingHp: 100 };
  assert.ok(!isTankResultTie(a, b, 5, 5));
}
console.log('  PASS');

// ============================================================
// isBetterDpsResult tests
// ============================================================

console.log('\n--- isBetterDpsResult ---');

console.log('Test: lower monster remaining HP % wins');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 50, winRate: 50 };
  const b = { avgMonsterRemainingHpPercent: 40, avgTurns: 30, winRate: 100 };
  assert.ok(isBetterDpsResult(a, b));
  assert.ok(!isBetterDpsResult(b, a));
}
console.log('  PASS');

console.log('Test: same damage → fewer turns wins');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  const b = { avgMonsterRemainingHpPercent: 20, avgTurns: 50, winRate: 50 };
  assert.ok(isBetterDpsResult(a, b));
}
console.log('  PASS');

console.log('Test: same damage, same turns → higher winRate wins');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 80 };
  const b = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  assert.ok(isBetterDpsResult(a, b));
}
console.log('  PASS');

console.log('Test: null handling');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  assert.ok(isBetterDpsResult(a, null));
  assert.ok(!isBetterDpsResult(null, a));
}
console.log('  PASS');

// ============================================================
// isDpsResultTie tests
// ============================================================

console.log('\n--- isDpsResultTie ---');

console.log('Test: same stats → tie');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  const b = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  assert.ok(isDpsResultTie(a, b));
}
console.log('  PASS');

console.log('Test: different monster HP → not a tie');
{
  const a = { avgMonsterRemainingHpPercent: 20, avgTurns: 30, winRate: 50 };
  const b = { avgMonsterRemainingHpPercent: 30, avgTurns: 30, winRate: 50 };
  assert.ok(!isDpsResultTie(a, b));
}
console.log('  PASS');

// ============================================================
// optimizeForRole integration tests
// ============================================================

console.log('\n--- optimizeForRole ---');

// Mock items
const ITEMS = {
  // Weapons
  fire_sword: {
    code: 'fire_sword', type: 'weapon', level: 10,
    effects: [{ name: 'attack_fire', value: 50 }],
  },
  earth_staff: {
    code: 'earth_staff', type: 'weapon', level: 10,
    effects: [{ name: 'attack_earth', value: 40 }, { name: 'hp', value: 30 }],
  },
  // Rings
  ring_of_adept: {
    code: 'ring_of_adept', type: 'ring', level: 10,
    effects: [{ name: 'threat', value: 50 }, { name: 'hp', value: 20 }],
  },
  ring_of_power: {
    code: 'ring_of_power', type: 'ring', level: 10,
    effects: [{ name: 'attack_fire', value: 15 }, { name: 'dmg_fire', value: 10 }],
  },
  ring_of_defense: {
    code: 'ring_of_defense', type: 'ring', level: 10,
    effects: [{ name: 'res_fire', value: 20 }, { name: 'hp', value: 50 }],
  },
  // Armor
  iron_helmet: {
    code: 'iron_helmet', type: 'helmet', level: 10,
    effects: [{ name: 'res_fire', value: 10 }, { name: 'hp', value: 30 }],
  },
  wooden_shield: {
    code: 'wooden_shield', type: 'shield', level: 1,
    effects: [
      { name: 'res_fire', value: 2 },
      { name: 'res_earth', value: 2 },
      { name: 'res_water', value: 2 },
      { name: 'res_air', value: 2 },
    ],
  },
  slime_shield: {
    code: 'slime_shield', type: 'shield', level: 15,
    effects: [
      { name: 'res_fire', value: 7 },
      { name: 'res_earth', value: 7 },
      { name: 'res_water', value: 7 },
      { name: 'res_air', value: 7 },
    ],
  },
  // Amulet
  amulet_of_might: {
    code: 'amulet_of_might', type: 'amulet', level: 10,
    effects: [{ name: 'attack_fire', value: 10 }, { name: 'dmg', value: 5 }],
  },
};

const MONSTER = {
  code: 'test_boss',
  type: 'boss',
  level: 15,
  hp: 500,
  max_hp: 500,
  attack_fire: 30,
  attack_earth: 0,
  attack_water: 0,
  attack_air: 0,
  dmg_fire: 0,
  dmg_earth: 0,
  dmg_water: 0,
  dmg_air: 0,
  res_fire: 10,
  res_earth: 0,
  res_water: 0,
  res_air: 0,
  dmg: 0,
  critical_strike: 0,
  initiative: 10,
  effects: [],
};

function makeTestCtx(name, equipped = {}) {
  const char = {
    name,
    level: 15,
    hp: 200,
    max_hp: 200,
    attack_fire: 0, attack_earth: 0, attack_water: 0, attack_air: 0,
    dmg_fire: 0, dmg_earth: 0, dmg_water: 0, dmg_air: 0,
    dmg: 0,
    res_fire: 0, res_earth: 0, res_water: 0, res_air: 0,
    critical_strike: 5,
    initiative: 10,
    inventory: [],
    inventory_max_items: 20,
    weapon_slot: equipped.weapon || '',
    shield_slot: '', helmet_slot: '', body_armor_slot: '', leg_armor_slot: '',
    boots_slot: '', ring1_slot: '', ring2_slot: '', amulet_slot: '',
    artifact1_slot: '', artifact2_slot: '', artifact3_slot: '',
    utility1_slot: '', utility1_slot_quantity: 0,
    utility2_slot: '', utility2_slot_quantity: 0,
    rune_slot: '', bag_slot: '',
  };
  // Apply equipped items' effects to stats (mimics what the API returns)
  for (const [slot, code] of Object.entries(equipped)) {
    if (!code) continue;
    char[`${slot}_slot`] = code;
    const item = ITEMS[code];
    if (!item?.effects) continue;
    for (const eff of item.effects) {
      const key = eff.name === 'hp' ? 'max_hp' : eff.name;
      char[key] = (char[key] || 0) + eff.value;
    }
    char.hp = char.max_hp;
  }
  return {
    name,
    get: () => char,
    hasItem: () => false,
    itemCount: () => 0,
    inventoryCount: () => 0,
    inventoryCapacity: () => 20,
    inventoryFull: () => false,
    skillLevel: () => 15,
  };
}

// Setup mocks
_setDepsForTests({
  getMonsterFn: (code) => code === 'test_boss' ? MONSTER : null,
  getItemFn: (code) => ITEMS[code] || null,
  getEquipmentForSlotFn: (slot, level) => {
    return Object.values(ITEMS).filter(item => {
      if (item.level > level) return false;
      if (slot === 'weapon') return item.type === 'weapon';
      if (slot === 'shield') return item.type === 'shield';
      if (slot === 'ring1' || slot === 'ring2') return item.type === 'ring';
      if (slot === 'helmet') return item.type === 'helmet';
      if (slot === 'amulet') return item.type === 'amulet';
      return false;
    });
  },
  getBankItemsFn: async () => {
    // All items available in bank
    const map = new Map();
    for (const code of Object.keys(ITEMS)) {
      map.set(code, 5);
    }
    return map;
  },
  bankCountFn: () => 5,
  findItemsFn: () => [],
  findNpcForItemFn: () => null,
  // Simple sim: just compute stats for comparison
  simulateCombatFn: (charStats, monsterStats, opts) => {
    // Simple damage calc for testing
    const charDmg = Math.max(1,
      (charStats.attack_fire || 0) + (charStats.attack_earth || 0)
      + (charStats.attack_water || 0) + (charStats.attack_air || 0),
    );
    const monsterDmg = Math.max(1,
      (monsterStats.attack_fire || 0) + (monsterStats.attack_earth || 0)
      + (monsterStats.attack_water || 0) + (monsterStats.attack_air || 0),
    );
    const charHp = Math.max(1, charStats.max_hp || charStats.hp || 100);
    const monsterHp = Math.max(1, monsterStats.max_hp || monsterStats.hp || 100);

    const turnsToKillMonster = Math.ceil(monsterHp / charDmg);
    const turnsToKillChar = Math.ceil(charHp / monsterDmg);
    const win = turnsToKillChar > turnsToKillMonster;
    const turns = Math.min(turnsToKillChar, turnsToKillMonster);
    const monsterRemainingHpPercent = win
      ? 0
      : Math.max(0, ((monsterHp - charDmg * turns) / monsterHp) * 100);

    return {
      winRate: win ? 100 : 0,
      canWin: win,
      avgTurns: turns,
      avgRemainingHp: win ? Math.max(0, charHp - monsterDmg * turns) : 0,
      avgHpLostPercent: 0,
      avgMonsterRemainingHpPercent: monsterRemainingHpPercent,
      iterations: opts?.iterations || 200,
    };
  },
  findRequiredHpForFightFn: () => ({ requiredHp: 100 }),
});

console.log('Test: tank optimizer picks threat ring over pure defense ring');
{
  const ctx = makeTestCtx('TankTest', { weapon: 'fire_sword' });
  const result = await optimizeForRole(ctx, 'test_boss', 'tank');
  assert.ok(result, 'Should return a result');
  // Tank should pick ring_of_adept for ring1 (has threat)
  const ring1 = result.loadout.get('ring1');
  assert.equal(ring1, 'ring_of_adept', `Tank ring1 should be ring_of_adept, got ${ring1}`);
  assert.ok(result.gearThreat > 0, 'Tank should have positive gearThreat');
}
console.log('  PASS');

console.log('Test: DPS optimizer never picks threat ring');
{
  const ctx = makeTestCtx('DpsTest', { weapon: 'fire_sword' });
  const result = await optimizeForRole(ctx, 'test_boss', 'dps');
  assert.ok(result, 'Should return a result');
  const ring1 = result.loadout.get('ring1');
  const ring2 = result.loadout.get('ring2');
  assert.notEqual(ring1, 'ring_of_adept', `DPS ring1 should NOT be ring_of_adept, got ${ring1}`);
  assert.notEqual(ring2, 'ring_of_adept', `DPS ring2 should NOT be ring_of_adept, got ${ring2}`);
  // DPS should pick ring_of_power (damage stats)
  assert.equal(ring1, 'ring_of_power', `DPS ring1 should be ring_of_power, got ${ring1}`);
}
console.log('  PASS');

console.log('Test: DPS optimizer picks damage-focused gear');
{
  const ctx = makeTestCtx('DpsTest2');
  const result = await optimizeForRole(ctx, 'test_boss', 'dps');
  assert.ok(result, 'Should return a result');
  // Should pick amulet_of_might (damage stats)
  const amulet = result.loadout.get('amulet');
  assert.equal(amulet, 'amulet_of_might', `DPS amulet should be amulet_of_might, got ${amulet}`);
}
console.log('  PASS');

console.log('Test: tank gearThreat is reported correctly');
{
  const ctx = makeTestCtx('TankThreat');
  const result = await optimizeForRole(ctx, 'test_boss', 'tank');
  // ring_of_adept has threat=50, if equipped in both ring slots that's 100
  // (depends on availability and duplicate family filtering)
  assert.ok(result.gearThreat >= 50, `Tank gearThreat should be >= 50, got ${result.gearThreat}`);
}
console.log('  PASS');

console.log('Test: optimizeForRole returns null for unknown monster');
{
  const ctx = makeTestCtx('Nobody');
  const result = await optimizeForRole(ctx, 'nonexistent_boss', 'tank');
  assert.equal(result, null);
}
console.log('  PASS');

console.log('Test: tank optimizer skips strictly worse shield');
{
  _setDepsForTests({
    simulateCombatFn: (charStats, _monsterStats, opts) => ({
      winRate: 100,
      canWin: true,
      avgTurns: charStats.res_fire === 2 ? 40 : 20,
      avgRemainingHp: charStats.res_fire === 2 ? 300 : 100,
      avgHpLostPercent: 0,
      avgMonsterRemainingHpPercent: 0,
      iterations: opts?.iterations || 200,
    }),
  });
  const ctx = makeTestCtx('TankShield');
  const result = await optimizeForRole(ctx, 'test_boss', 'tank');
  assert.equal(result.loadout.get('shield'), 'slime_shield');
}
console.log('  PASS');

console.log('Test: dps optimizer skips strictly worse shield');
{
  _setDepsForTests({
    simulateCombatFn: (charStats, _monsterStats, opts) => ({
      winRate: 100,
      canWin: true,
      avgTurns: 3,
      avgRemainingHp: 100,
      avgHpLostPercent: 0,
      avgMonsterRemainingHpPercent: charStats.res_fire === 2 ? 0 : 50,
      iterations: opts?.iterations || 200,
    }),
  });
  const ctx = makeTestCtx('DpsShield');
  const result = await optimizeForRole(ctx, 'test_boss', 'dps');
  assert.equal(result.loadout.get('shield'), 'slime_shield');
}
console.log('  PASS');

// Cleanup
_resetDepsForTests();

console.log('\nAll boss-role-optimizer tests passed!');
