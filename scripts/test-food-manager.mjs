#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const api = await import('../src/api.mjs');
const gameData = await import('../src/services/game-data.mjs');
const { getFightReadiness, restBeforeFight } = await import('../src/services/food-manager.mjs');

const {
  _setCachesForTests: setGameDataCachesForTests,
  _resetForTests: resetGameDataForTests,
} = gameData;

function makeCtx({
  hp = 100,
  maxHp = 100,
  attackFire = 50,
  initiative = 10,
  inventory = [],
} = {}) {
  let character = {
    name: 'Tester',
    hp,
    max_hp: maxHp,
    attack_fire: attackFire,
    initiative,
    inventory,
  };

  return {
    name: 'Tester',
    get() {
      return character;
    },
    hpPercent() {
      return Math.floor((character.hp / character.max_hp) * 100);
    },
    applyActionResult(result) {
      if (result?.character && typeof result.character === 'object') {
        character = { ...character, ...result.character };
      }
    },
  };
}

function setMonsters(monsters) {
  setGameDataCachesForTests({
    monsters: monsters.map(monster => [monster.code, monster]),
  });
}

async function withImmediateTimers(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _ms, ...args) => {
    callback(...args);
    return 0;
  };
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

async function withMockFetch(fetchImpl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testUnwinnableWhenSimulationLoses() {
  resetGameDataForTests();
  setMonsters([
    {
      code: 'ogre',
      hp: 100,
      attack_fire: 100,
    },
  ]);

  const readiness = await getFightReadiness(makeCtx({ hp: 100, maxHp: 100, attackFire: 30 }), 'ogre');
  assert.equal(readiness.status, 'unwinnable');
  assert.equal(readiness.requiredHp, null);
  assert.equal(readiness.targetPct, null);
}

async function testRestCanReachRequiredHpThreshold() {
  resetGameDataForTests();
  setMonsters([
    {
      code: 'boar',
      hp: 100,
      attack_fire: 91,
    },
  ]);

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        data: {
          cooldown: { total_seconds: 0, remaining_seconds: 0 },
          character: { hp: 100, max_hp: 100 },
        },
      });
    },
  });

  const ctx = makeCtx({ hp: 50, maxHp: 100, attackFire: 50 });
  await withMockFetch(fetchImpl, async () => {
    const readiness = await getFightReadiness(ctx, 'boar');
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.requiredHp, 92);
    assert.equal(readiness.maxHp, 100);
    assert.equal(await restBeforeFight(makeCtx({ hp: 50, maxHp: 100, attackFire: 50 }), 'boar'), true);
  });
}

async function testReadyWhenCurrentHpIsEnough() {
  resetGameDataForTests();
  setMonsters([
    {
      code: 'slime',
      hp: 50,
      attack_fire: 1,
    },
  ]);

  const ctx = makeCtx({ hp: 100, maxHp: 100, attackFire: 50 });
  const readiness = await getFightReadiness(ctx, 'slime');
  assert.equal(readiness.status, 'ready');
  assert.ok(readiness.requiredHp <= ctx.get().hp);
  assert.equal(await restBeforeFight(ctx, 'slime'), true);
}

async function testNeedsRestWhenRestFailsButFightIsReachable() {
  resetGameDataForTests();
  api.resetCooldownAbort();
  setMonsters([
    {
      code: 'wolf',
      hp: 100,
      attack_fire: 80,
    },
  ]);

  const fetchImpl = async () => ({
    ok: false,
    status: 496,
    async text() {
      return JSON.stringify({
        error: {
          code: 496,
          message: 'Condition not met',
        },
      });
    },
  });

  const ctx = makeCtx({ hp: 20, maxHp: 100, attackFire: 50 });
  await withImmediateTimers(async () => {
    await withMockFetch(fetchImpl, async () => {
      const readiness = await getFightReadiness(ctx, 'wolf');
      assert.equal(readiness.status, 'needs_rest');
      assert.equal(readiness.requiredHp, 81);
      assert.equal(await restBeforeFight(ctx, 'wolf'), false);
    });
  });
}

async function run() {
  try {
    await testUnwinnableWhenSimulationLoses();
    await testRestCanReachRequiredHpThreshold();
    await testReadyWhenCurrentHpIsEnough();
    await testNeedsRestWhenRestFailsButFightIsReachable();
    console.log('food-manager tests passed');
  } finally {
    api.resetCooldownAbort();
    resetGameDataForTests();
  }
}

run().catch((err) => {
  api.resetCooldownAbort();
  resetGameDataForTests();
  console.error(err);
  process.exit(1);
});
