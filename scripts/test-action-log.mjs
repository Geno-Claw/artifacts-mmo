#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  describeActionResult,
  extractAccountLogDetail,
} from '../src/action-log.mjs';

function testFightAccountLogUsesOpponentField() {
  const detail = extractAccountLogDetail('fight', {
    fight: {
      result: 'win',
      opponent: 'mushmush',
      characters: [{
        character_name: 'Alpha',
        xp: 12,
        gold: 3,
        drops: [{ code: 'mushroom', quantity: 1 }],
      }],
    },
  }, { characterName: 'Alpha' });

  assert.deepEqual(detail, {
    result: 'win',
    monster: 'mushmush',
    xp: 12,
    gold: 3,
    drops: [{ code: 'mushroom', qty: 1 }],
    turns: [],
  });
}

function testFightAccountLogParsesDescriptionFallback() {
  const detail = extractAccountLogDetail('fight', {
    fight: {
      result: 'loss',
      characters: [{
        character_name: 'Alpha',
        xp: 0,
        gold: 0,
        drops: [],
      }],
    },
  }, {
    characterName: 'Alpha',
    description: 'Lost against mushmush after 3 turns',
  });

  assert.equal(detail.monster, 'mushmush');
}

function testFightActionSummaryUsesApiOpponent() {
  const result = describeActionResult('fight', {
    cooldown: { total_seconds: 5, remaining_seconds: 5 },
    fight: {
      result: 'win',
      opponent: 'mushmush',
      turns: 2,
      logs: [],
      characters: [{
        character_name: 'Alpha',
        xp: 7,
        gold: 3,
        drops: [{ code: 'mushroom', quantity: 1 }],
        final_hp: 24,
      }],
    },
    characters: [{ name: 'Alpha' }],
  }, { characterName: 'Alpha' });

  assert.equal(result.type, 'fight');
  assert.equal(result.summary, 'Won vs mushmush +7xp +3g mushroomx1');
  assert.deepEqual(result.detail, {
    result: 'win',
    monster: 'mushmush',
    xp: 7,
    gold: 3,
    drops: [{ code: 'mushroom', qty: 1 }],
    turns: [],
  });
}

function testCraftingActionSummaryUsesRequestBody() {
  const result = describeActionResult('crafting', {
    details: {
      xp: 18,
      items: [{ code: 'copper_dagger', quantity: 2 }],
    },
  }, {
    requestBody: {
      code: 'copper_dagger',
      quantity: 2,
    },
  });

  assert.equal(result.type, 'crafting');
  assert.equal(result.summary, 'Crafted copper_dagger x2 +18xp');
}

function run() {
  testFightAccountLogUsesOpponentField();
  testFightAccountLogParsesDescriptionFallback();
  testFightActionSummaryUsesApiOpponent();
  testCraftingActionSummaryUsesRequestBody();
  console.log('test-action-log: PASS');
}

run();
