/**
 * Tests for interruptible cooldown waits.
 * Verifies that abortAllCooldowns() instantly resolves pending waitForCooldown() calls,
 * and that resetCooldownAbort() restores normal behavior.
 */
import assert from 'node:assert/strict';
import { waitForCooldown, abortAllCooldowns, resetCooldownAbort } from '../src/api.mjs';

// ── Test 1: waitForCooldown resolves instantly when aborted ──
{
  resetCooldownAbort();
  const start = Date.now();
  const promise = waitForCooldown({ cooldown: { remaining_seconds: 30 } });
  abortAllCooldowns();
  await promise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Expected <100ms after abort, got ${elapsed}ms`);
  console.log(`  PASS  abort resolves pending wait (${elapsed}ms)`);
}

// ── Test 2: waitForCooldown resolves instantly if already aborted ──
{
  resetCooldownAbort();
  abortAllCooldowns();
  const start = Date.now();
  await waitForCooldown({ cooldown: { remaining_seconds: 30 } });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `Expected <50ms when pre-aborted, got ${elapsed}ms`);
  console.log(`  PASS  pre-aborted controller resolves instantly (${elapsed}ms)`);
}

// ── Test 3: after reset, normal cooldown waits work ──
{
  resetCooldownAbort();
  const start = Date.now();
  await waitForCooldown({ cooldown: { remaining_seconds: 0.05 } });
  const elapsed = Date.now() - start;
  // 50ms cooldown + 500ms buffer = ~550ms expected
  assert.ok(elapsed >= 400, `Expected >=400ms for normal wait, got ${elapsed}ms`);
  console.log(`  PASS  normal wait after reset works (${elapsed}ms)`);
}

// ── Test 4: zero/missing cooldown resolves immediately regardless ──
{
  resetCooldownAbort();
  const start = Date.now();
  await waitForCooldown({});
  await waitForCooldown(null);
  await waitForCooldown({ cooldown: { remaining_seconds: 0 } });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `Expected <50ms for zero cooldowns, got ${elapsed}ms`);
  console.log(`  PASS  zero/missing cooldown resolves instantly (${elapsed}ms)`);
}

// ── Test 5: multiple concurrent waits all resolve on abort ──
{
  resetCooldownAbort();
  const start = Date.now();
  const promises = [
    waitForCooldown({ cooldown: { remaining_seconds: 30 } }),
    waitForCooldown({ cooldown: { remaining_seconds: 25 } }),
    waitForCooldown({ cooldown: { remaining_seconds: 20 } }),
    waitForCooldown({ cooldown: { remaining_seconds: 15 } }),
    waitForCooldown({ cooldown: { remaining_seconds: 10 } }),
  ];
  abortAllCooldowns();
  await Promise.all(promises);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Expected <100ms for 5 concurrent aborts, got ${elapsed}ms`);
  console.log(`  PASS  5 concurrent waits all abort (${elapsed}ms)`);
}

// Clean up for any subsequent imports
resetCooldownAbort();

console.log('\nAll cooldown abort tests passed');
