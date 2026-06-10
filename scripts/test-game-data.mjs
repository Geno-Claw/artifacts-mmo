#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  _resetForTests,
  _setCachesForTests,
  canSellToNpc,
  checkPlanPrerequisites,
  findBestNpcSellOffer,
  getNpcSellOffer,
  getNpcSellPrice,
} from '../src/services/game-data.mjs';

function makeCtx({ skills = {}, items = {} } = {}) {
  return {
    skillLevel: (skill) => skills[skill] || 0,
    itemCount: (code) => items[code] || 0,
  };
}

function testNpcSellOfferAccessors() {
  _resetForTests();
  _setCachesForTests({
    npcSellOffers: [
      ['nomadic_merchant', [
        ['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 500 }],
      ]],
      ['fish_merchant', [
        ['old_boots', { code: 'old_boots', currency: 'gold', sellPrice: 450 }],
        ['cooked_shrimp', { code: 'cooked_shrimp', currency: 'shell_token', sellPrice: 7 }],
      ]],
    ],
  });

  assert.equal(canSellToNpc('nomadic_merchant', 'old_boots'), true);
  assert.equal(canSellToNpc('nomadic_merchant', 'cooked_shrimp'), false);
  assert.deepEqual(getNpcSellOffer('nomadic_merchant', 'old_boots'), {
    code: 'old_boots',
    currency: 'gold',
    sellPrice: 500,
  });
  assert.equal(getNpcSellPrice('fish_merchant', 'cooked_shrimp'), 7);
  assert.deepEqual(findBestNpcSellOffer('old_boots'), {
    npcCode: 'nomadic_merchant',
    currency: 'gold',
    sellPrice: 500,
  });
  assert.deepEqual(findBestNpcSellOffer('cooked_shrimp'), {
    npcCode: 'fish_merchant',
    currency: 'shell_token',
    sellPrice: 7,
  });
  assert.equal(getNpcSellOffer('fish_merchant', 'missing_item'), null);
  assert.equal(findBestNpcSellOffer('missing_item'), null);
}

function testPlanPrerequisitesBankAwareSkillCoverage() {
  const plan = [
    {
      type: 'gather',
      itemCode: 'raw_fish',
      quantity: 2,
      resource: { code: 'fish_spot', skill: 'fishing', level: 10 },
    },
    {
      type: 'craft',
      itemCode: 'fish_fillet',
      quantity: 1,
      recipe: { skill: 'cooking', level: 8 },
    },
  ];

  const ctx = makeCtx({ skills: { fishing: 1, cooking: 8 } });
  assert.deepEqual(
    checkPlanPrerequisites(plan, ctx, new Map([['raw_fish', 6]]), { quantityMultiplier: 3 }).ok,
    true,
  );

  const blocked = checkPlanPrerequisites(plan, ctx, new Map([['raw_fish', 5]]), { quantityMultiplier: 3 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.length, 1);
  assert.equal(blocked.blockers[0].type, 'gather_skill');
  assert.equal(blocked.blockers[0].requiredQuantity, 6);
  assert.equal(blocked.blockers[0].availableQuantity, 5);
}

function testPlanPrerequisitesReportsMultipleBlockers() {
  const plan = [
    {
      type: 'gather',
      itemCode: 'ore',
      quantity: 3,
      resource: { code: 'iron_rocks', skill: 'mining', level: 15 },
    },
    {
      type: 'craft',
      itemCode: 'iron_bar',
      quantity: 1,
      recipe: { skill: 'weaponcrafting', level: 12 },
    },
    {
      type: 'fight',
      itemCode: 'fang',
      quantity: 1,
      monster: { code: 'wolf', level: 8 },
    },
  ];
  const result = checkPlanPrerequisites(plan, makeCtx({ skills: { mining: 1, weaponcrafting: 1 } }), new Map());
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers.map(b => b.type), ['gather_skill', 'craft_skill']);
}

function testPlanPrerequisitesBankDependenciesOptional() {
  const plan = [{ type: 'bank', itemCode: 'event_token', quantity: 4 }];
  const ctx = makeCtx();
  assert.equal(checkPlanPrerequisites(plan, ctx, new Map()).ok, true);
  const blocked = checkPlanPrerequisites(plan, ctx, new Map([['event_token', 3]]), {
    checkBankDependencies: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers[0].type, 'bank_dependency');
}

function run() {
  try {
    testNpcSellOfferAccessors();
    testPlanPrerequisitesBankAwareSkillCoverage();
    testPlanPrerequisitesReportsMultipleBlockers();
    testPlanPrerequisitesBankDependenciesOptional();
    console.log('test-game-data: PASS');
  } finally {
    _resetForTests();
  }
}

run();
