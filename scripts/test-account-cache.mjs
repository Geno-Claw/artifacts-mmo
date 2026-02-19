#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';
process.env.ARTIFACTS_API ||= 'https://artifacts-api.test';

const DETAILS_TTL_MS = 5 * 60 * 1000;
const ACHIEVEMENTS_TTL_MS = 10 * 60 * 1000;

function createJsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function normalizeFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function createArtifactsApiMock(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const state = {
    detailsCalls: 0,
    achievementsCalls: 0,
  };

  return {
    state,
    handles(urlText) {
      return urlText.startsWith(normalizedBase);
    },
    async fetch(urlText) {
      const url = new URL(urlText);

      if (url.pathname === '/my/details') {
        state.detailsCalls++;
        return createJsonResponse(200, {
          data: {
            account: 'qa-account',
            username: 'qa-account',
            name: 'qa-account',
            achievements: {
              completed: 2,
              total: 5,
              inProgress: 3,
            },
            achievements_completed: 2,
            achievements_total: 5,
            achievements_in_progress: 3,
          },
        });
      }

      if (url.pathname.includes('/achievements')) {
        state.achievementsCalls++;
        return createJsonResponse(200, {
          data: [
            {
              code: 'first_steps',
              title: 'First Steps',
              completed: true,
              progress: 1,
              total: 1,
            },
            {
              code: 'ore_hoarder',
              title: 'Ore Hoarder',
              completed: false,
              progress: 12,
              total: 100,
            },
          ],
        });
      }

      return createJsonResponse(404, {
        error: {
          code: 404,
          message: `No mock for ${url.pathname}`,
        },
      });
    },
  };
}

function pickMethod(targets, preferredNames, pattern, label) {
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    for (const name of preferredNames) {
      if (typeof target[name] === 'function') {
        return { ctx: target, fn: target[name], name };
      }
    }
  }

  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    for (const [name, value] of Object.entries(target)) {
      if (name.startsWith('_')) continue;
      if (name === 'createAccountCache') continue;
      if (!pattern.test(name)) continue;
      if (typeof value !== 'function') continue;
      return { ctx: target, fn: value, name };
    }
  }

  const available = targets
    .filter(target => target && typeof target === 'object')
    .flatMap(target => Object.keys(target));
  throw new Error(`Missing ${label} export; available exports: ${available.join(', ')}`);
}

function pickOptionalMethod(targets, names) {
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    for (const name of names) {
      if (typeof target[name] === 'function') {
        return { ctx: target, fn: target[name], name };
      }
    }
  }
  return null;
}

function makeAdaptiveInvoker(method, argFactories, label) {
  let selectedFactory = null;

  return async function invoke() {
    if (selectedFactory) {
      return method.fn.apply(method.ctx, selectedFactory());
    }

    let lastErr = null;
    for (const factory of argFactories) {
      try {
        const result = await method.fn.apply(method.ctx, factory());
        selectedFactory = factory;
        return result;
      } catch (err) {
        lastErr = err;
      }
    }

    const details = lastErr ? `${lastErr.name}: ${lastErr.message}` : 'no invocation attempts';
    throw new Error(`Unable to call ${label} (${method.name}): ${details}`);
  };
}

function createServiceHarness(mod) {
  let target = mod;
  if (typeof mod.createAccountCache === 'function') {
    try {
      target = mod.createAccountCache({
        detailsTtlMs: DETAILS_TTL_MS,
        achievementsTtlMs: ACHIEVEMENTS_TTL_MS,
      });
    } catch {
      target = mod.createAccountCache();
    }
  }

  if (!target || typeof target !== 'object') {
    throw new Error('account-cache service did not provide a usable API object');
  }

  const targets = [target, mod];
  const summaryMethod = pickMethod(
    targets,
    ['getAccountSummary', 'getSummary', 'getCachedAccountSummary', 'getAccountDetails', 'getDetails'],
    /summary|details/i,
    'account summary getter',
  );
  const achievementsMethod = pickMethod(
    targets,
    ['getAccountAchievements', 'getAchievements', 'getCachedAccountAchievements'],
    /achievement/i,
    'account achievements getter',
  );
  const resetMethod = pickOptionalMethod(targets, ['_resetForTests', 'resetForTests', '_resetCacheForTests']);

  return {
    getSummary: makeAdaptiveInvoker(summaryMethod, [
      () => [],
      () => [{}],
      () => ['qa-account'],
      () => [{ account: 'qa-account' }],
    ], 'account summary getter'),
    getAchievements: makeAdaptiveInvoker(achievementsMethod, [
      () => ['qa-account', { page: 1, size: 50 }],
      () => [{ account: 'qa-account', page: 1, size: 50 }],
      () => ['qa-account'],
      () => [{}],
      () => [],
    ], 'account achievements getter'),
    reset() {
      if (resetMethod) resetMethod.fn.call(resetMethod.ctx);
    },
  };
}

async function run() {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const apiMock = createArtifactsApiMock(process.env.ARTIFACTS_API || 'https://artifacts-api.test');
  let nowMs = 1_700_000_000_000;
  let harness = null;

  Date.now = () => nowMs;
  globalThis.fetch = async (input, init) => {
    const urlText = normalizeFetchUrl(input);
    if (apiMock.handles(urlText)) {
      return apiMock.fetch(urlText, init);
    }
    return originalFetch(input, init);
  };

  try {
    let mod = null;
    try {
      mod = await import('../src/services/account-cache.mjs');
    } catch (err) {
      throw new Error(`Failed to import ../src/services/account-cache.mjs: ${err.message}`);
    }

    harness = createServiceHarness(mod);
    harness.reset();

    const detailsBefore = apiMock.state.detailsCalls;
    const summaryMiss = await harness.getSummary();
    assert.notEqual(summaryMiss, undefined, 'account summary miss should return payload');
    assert.equal(apiMock.state.detailsCalls, detailsBefore + 1, 'cache miss should fetch account summary/details');

    nowMs += DETAILS_TTL_MS - 1;
    await harness.getSummary();
    assert.equal(apiMock.state.detailsCalls, detailsBefore + 1, 'cache hit within details TTL should not refetch');

    nowMs += 2;
    await harness.getSummary();
    assert.equal(apiMock.state.detailsCalls, detailsBefore + 2, 'details TTL expiry should refresh upstream fetch');

    const achievementsBefore = apiMock.state.achievementsCalls;
    const achievementsMiss = await harness.getAchievements();
    assert.notEqual(achievementsMiss, undefined, 'account achievements miss should return payload');
    assert.equal(apiMock.state.achievementsCalls, achievementsBefore + 1, 'cache miss should fetch achievements');

    nowMs += ACHIEVEMENTS_TTL_MS - 1;
    await harness.getAchievements();
    assert.equal(apiMock.state.achievementsCalls, achievementsBefore + 1, 'cache hit within achievements TTL should not refetch');

    nowMs += 2;
    await harness.getAchievements();
    assert.equal(apiMock.state.achievementsCalls, achievementsBefore + 2, 'achievements TTL expiry should refresh upstream fetch');

    harness.reset();
    console.log('test-account-cache: PASS');
  } finally {
    if (harness) {
      try {
        harness.reset();
      } catch {
        // No-op
      }
    }
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
