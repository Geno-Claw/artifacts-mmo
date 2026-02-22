#!/usr/bin/env node
import assert from 'node:assert/strict';

const { normalizeConfig } = await import('../src/services/config-store.mjs');

// ── Test helpers ──

function log(label) {
  console.log(`  PASS  ${label}`);
}

// ── Tests ──

async function testMinimalRestRoutine() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'rest' }] },
    ],
  };

  const { config, changed } = await normalizeConfig(input);
  assert.equal(changed, true, 'should detect that defaults were added');

  const rest = config.characters[0].routines[0];
  assert.equal(rest.type, 'rest');
  assert.equal(rest.priority, 100, 'rest priority default');
  assert.equal(rest.triggerPct, 40, 'rest triggerPct default');
  assert.equal(rest.targetPct, 80, 'rest targetPct default');

  log('minimal rest routine gets all defaults');
}

async function testMinimalDepositBankRoutine() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'depositBank' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.priority, 50);
  assert.equal(r.threshold, 0.8);
  assert.equal(r.sellOnGE, true);
  assert.equal(r.recycleEquipment, true);
  assert.equal(r.depositGold, true);

  log('minimal depositBank routine gets all defaults');
}

async function testMinimalEventRoutine() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'event' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.priority, 90);
  assert.equal(r.enabled, true);
  assert.equal(r.monsterEvents, true);
  assert.equal(r.resourceEvents, true);
  assert.equal(r.npcEvents, false);
  assert.equal(r.minTimeRemainingMs, 120000);
  assert.equal(r.maxMonsterType, 'elite');
  assert.equal(r.cooldownMs, 60000);
  assert.equal(r.minWinrate, 80);

  log('minimal event routine gets all defaults');
}

async function testMinimalSkillRotation() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [{ type: 'skillRotation', weights: { combat: 1 } }],
      },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.priority, 5);
  assert.equal(r.maxLosses, 2);
  assert.deepEqual(r.craftBlacklist, {});
  assert.deepEqual(r.taskCollection, {});
  assert.deepEqual(r.achievementBlacklist, []);
  assert.ok(Array.isArray(r.achievementTypes), 'achievementTypes should be array');
  assert.ok(r.achievementTypes.includes('combat_kill'), 'achievementTypes should include combat_kill');

  // orderBoard should get full defaults
  assert.equal(r.orderBoard.enabled, false);
  assert.equal(r.orderBoard.createOrders, false);
  assert.equal(r.orderBoard.fulfillOrders, false);
  assert.equal(r.orderBoard.leaseMs, 120000);
  assert.equal(r.orderBoard.blockedRetryMs, 600000);

  // goals should get the schema default since not provided
  assert.ok(typeof r.goals === 'object', 'goals should be populated');
  assert.equal(r.goals.mining, 20);
  assert.equal(r.goals.combat, 10);

  // weights should preserve user value, not be replaced
  assert.equal(r.weights.combat, 1);

  log('minimal skillRotation gets all defaults');
}

async function testSettingsDeepMerge() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [{ type: 'rest' }],
        settings: {
          potions: {
            combat: { enabled: true },
          },
        },
      },
    ],
  };

  const { config } = await normalizeConfig(input);
  const s = config.characters[0].settings;

  // Global potion toggle
  assert.equal(s.potions.enabled, true);

  // Combat potion settings — user set enabled, rest should be defaults
  assert.equal(s.potions.combat.enabled, true);
  assert.equal(s.potions.combat.refillBelow, 2);
  assert.equal(s.potions.combat.targetQuantity, 5);
  assert.equal(s.potions.combat.poisonBias, true);
  assert.equal(s.potions.combat.respectNonPotionUtility, true);
  assert.deepEqual(s.potions.combat.monsterTypes, ['elite', 'boss']);

  // Bank travel settings should be fully populated
  assert.equal(s.potions.bankTravel.enabled, false);
  assert.equal(s.potions.bankTravel.mode, 'smart');
  assert.equal(s.potions.bankTravel.allowRecall, true);
  assert.equal(s.potions.bankTravel.allowForestBank, true);
  assert.equal(s.potions.bankTravel.minSavingsSeconds, 60);
  assert.equal(s.potions.bankTravel.includeReturnToOrigin, true);
  assert.equal(s.potions.bankTravel.moveSecondsPerTile, 5);
  assert.equal(s.potions.bankTravel.itemUseSeconds, 3);

  log('settings deep merge fills all nested defaults');
}

async function testSettingsCreatedWhenMissing() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'rest' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  const s = config.characters[0].settings;

  assert.ok(s, 'settings should be created');
  assert.ok(s.potions, 'potions should be created');
  assert.equal(s.potions.enabled, true);
  assert.ok(s.potions.combat, 'combat potions should be created');
  assert.ok(s.potions.bankTravel, 'bankTravel should be created');

  log('settings tree created from scratch when missing');
}

async function testOneOfRoutingMixed() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [
          { type: 'rest' },
          { type: 'depositBank', threshold: 0.5 },
          { type: 'skillRotation', weights: { mining: 1 } },
        ],
      },
    ],
  };

  const { config } = await normalizeConfig(input);
  const routines = config.characters[0].routines;

  // rest
  assert.equal(routines[0].priority, 100);
  assert.equal(routines[0].triggerPct, 40);

  // depositBank — user override preserved
  assert.equal(routines[1].threshold, 0.5);
  assert.equal(routines[1].priority, 50);
  assert.equal(routines[1].sellOnGE, true);

  // skillRotation
  assert.equal(routines[2].priority, 5);
  assert.equal(routines[2].weights.mining, 1);
  assert.ok(routines[2].orderBoard, 'orderBoard filled');

  log('oneOf routing handles mixed routine types correctly');
}

async function testIdempotency() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [{ type: 'rest' }],
      },
    ],
  };

  const { config: first } = await normalizeConfig(input);
  const { config: second, changed } = await normalizeConfig(first);

  assert.equal(changed, false, 'second normalization should detect no changes');
  assert.deepEqual(first, second, 'double-normalize produces identical output');

  log('normalization is idempotent');
}

async function testUnknownRoutineTypePassesThrough() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [{ type: 'unknownFutureRoutine', foo: 42 }],
      },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.type, 'unknownFutureRoutine');
  assert.equal(r.foo, 42);

  log('unknown routine type passes through unchanged');
}

async function testTopLevelDefaults() {
  const input = {
    characters: [],
  };

  const { config } = await normalizeConfig(input);

  // events should be created with gatherResources default
  assert.ok(config.events, 'events should be created');
  assert.deepEqual(config.events.gatherResources, []);

  log('top-level events defaults created when missing');
}

async function testUserOverridesPreserved() {
  const input = {
    characters: [
      {
        name: 'T',
        routines: [{ type: 'rest', triggerPct: 20, targetPct: 90, priority: 200 }],
        settings: {
          potions: {
            enabled: false,
            combat: {
              enabled: true,
              refillBelow: 10,
              targetQuantity: 50,
              monsterTypes: ['boss'],
            },
          },
        },
      },
    ],
  };

  const { config } = await normalizeConfig(input);
  const rest = config.characters[0].routines[0];
  assert.equal(rest.triggerPct, 20, 'user triggerPct preserved');
  assert.equal(rest.targetPct, 90, 'user targetPct preserved');
  assert.equal(rest.priority, 200, 'user priority preserved');

  const s = config.characters[0].settings;
  assert.equal(s.potions.enabled, false, 'user potions.enabled preserved');
  assert.equal(s.potions.combat.enabled, true, 'user combat.enabled preserved');
  assert.equal(s.potions.combat.refillBelow, 10, 'user refillBelow preserved');
  assert.equal(s.potions.combat.targetQuantity, 50, 'user targetQuantity preserved');
  assert.deepEqual(s.potions.combat.monsterTypes, ['boss'], 'user monsterTypes preserved');

  // But missing fields still get defaults
  assert.equal(s.potions.combat.poisonBias, true, 'missing poisonBias gets default');
  assert.ok(s.potions.bankTravel, 'missing bankTravel gets defaults');

  log('user overrides preserved while defaults fill gaps');
}

async function testBankExpansionDefaults() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'bankExpansion' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.priority, 45);
  assert.equal(r.checkIntervalMs, 300000);
  assert.equal(r.maxGoldPct, 0.7);
  assert.equal(r.goldBuffer, 0);

  log('bankExpansion routine gets all defaults');
}

async function testCompleteTaskDefaults() {
  const input = {
    characters: [
      { name: 'T', routines: [{ type: 'completeTask' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  const r = config.characters[0].routines[0];
  assert.equal(r.priority, 45);

  log('completeTask routine gets priority default');
}

async function testMultipleCharacters() {
  const input = {
    characters: [
      { name: 'A', routines: [{ type: 'rest' }] },
      { name: 'B', routines: [{ type: 'depositBank' }] },
    ],
  };

  const { config } = await normalizeConfig(input);
  assert.equal(config.characters[0].routines[0].priority, 100);
  assert.equal(config.characters[1].routines[0].priority, 50);

  // Both should have settings
  assert.ok(config.characters[0].settings, 'char A settings created');
  assert.ok(config.characters[1].settings, 'char B settings created');

  log('multiple characters each get defaults');
}

// ── Runner ──

async function run() {
  console.log('test-config-normalize');

  await testMinimalRestRoutine();
  await testMinimalDepositBankRoutine();
  await testMinimalEventRoutine();
  await testMinimalSkillRotation();
  await testSettingsDeepMerge();
  await testSettingsCreatedWhenMissing();
  await testOneOfRoutingMixed();
  await testIdempotency();
  await testUnknownRoutineTypePassesThrough();
  await testTopLevelDefaults();
  await testUserOverridesPreserved();
  await testBankExpansionDefaults();
  await testCompleteTaskDefaults();
  await testMultipleCharacters();

  console.log(`\nAll tests passed.\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
