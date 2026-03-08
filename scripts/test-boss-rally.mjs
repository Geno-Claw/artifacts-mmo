/**
 * Tests for boss-rally coordination service.
 */
import assert from 'node:assert/strict';
import {
  registerContext,
  unregisterContext,
  getAllContexts,
  getContext,
  getEligibleContexts,
  registerEnabledBosses,
  unregisterEnabledBosses,
  tryCreateRally,
  getRally,
  isRallyActive,
  isParticipant,
  checkIn,
  allCheckedIn,
  setPhase,
  setFightResult,
  markResultConsumed,
  allResultsConsumed,
  resetForNextFight,
  getFightCount,
  cancelRally,
  _resetForTests,
} from '../src/services/boss-rally.mjs';

function makeCtx(name, { cooldown = 0, full = false } = {}) {
  let keepCodes = {};
  return {
    name,
    cooldownRemainingMs: () => cooldown,
    inventoryFull: () => full,
    inventoryCount: () => full ? 100 : 10,
    inventoryCapacity: () => 100,
    clearRoutineKeepCodes: () => { keepCodes = {}; },
    setRoutineKeepCodes: (codes) => { keepCodes = codes; },
    getRoutineKeepCodes: () => keepCodes,
    get: () => ({ level: 27, hp: 1000, max_hp: 1000 }),
    _keepCodes: keepCodes,
  };
}

function setup3() {
  _resetForTests();
  const a = makeCtx('Alice');
  const b = makeCtx('Bob');
  const c = makeCtx('Carol');
  registerContext(a);
  registerContext(b);
  registerContext(c);
  return { a, b, c };
}

// --- Context registry ---

console.log('Test: context registry');
{
  _resetForTests();
  const a = makeCtx('Alice');
  registerContext(a);
  assert.equal(getContext('Alice'), a);
  assert.equal(getAllContexts().length, 1);

  const b = makeCtx('Bob');
  registerContext(b);
  assert.equal(getAllContexts().length, 2);

  unregisterContext('Alice');
  assert.equal(getAllContexts().length, 1);
  assert.equal(getContext('Alice'), null);
}
console.log('  PASS');

// --- CAS: tryCreateRally ---

console.log('Test: CAS rally creation');
{
  const { a } = setup3();
  const rally = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob', 'Carol'],
  });
  assert.ok(rally);
  assert.equal(rally.bossCode, 'king_slime');
  assert.equal(rally.leaderName, 'Alice');
  assert.deepEqual(rally.participants, ['Bob', 'Carol']);
  assert.equal(rally.phase, 'rallying');

  // Second creation should fail (CAS)
  const rally2 = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Bob',
    participants: ['Alice'],
  });
  assert.equal(rally2, null);
  assert.equal(getRally().leaderName, 'Alice');
}
console.log('  PASS');

// --- TTL cleanup ---

console.log('Test: TTL cleanup');
{
  setup3();
  const rally = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
    leaseTtlMs: 1, // 1ms TTL — will expire immediately
  });
  assert.ok(rally);

  // Wait for TTL to expire
  await new Promise(r => setTimeout(r, 5));
  assert.equal(isRallyActive(), false);
  assert.equal(getRally(), null);
}
console.log('  PASS');

// --- isParticipant ---

console.log('Test: isParticipant');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });
  assert.equal(isParticipant('Alice'), true); // leader is participant
  assert.equal(isParticipant('Bob'), true);
  assert.equal(isParticipant('Carol'), false);
}
console.log('  PASS');

// --- Check-in ---

console.log('Test: check-in and allCheckedIn');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob', 'Carol'],
  });
  assert.equal(allCheckedIn(), false);

  checkIn('Alice');
  assert.equal(allCheckedIn(), false);

  checkIn('Bob');
  assert.equal(allCheckedIn(), false);

  checkIn('Carol');
  assert.equal(allCheckedIn(), true);
}
console.log('  PASS');

// --- Phase transitions ---

console.log('Test: phase transitions');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });
  assert.equal(getRally().phase, 'rallying');

  setPhase('ready');
  assert.equal(getRally().phase, 'ready');

  setPhase('fighting');
  assert.equal(getRally().phase, 'fighting');

  setPhase('done');
  assert.equal(getRally().phase, 'done');
}
console.log('  PASS');

// --- Fight result and consumption ---

console.log('Test: fight result consumption');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob', 'Carol'],
  });

  const fakeResult = { fight: { result: 'win', turns: 10 } };
  setFightResult(fakeResult);
  assert.equal(getRally().fightResult, fakeResult);

  assert.equal(allResultsConsumed(), false);

  markResultConsumed('Alice');
  assert.equal(allResultsConsumed(), false);

  markResultConsumed('Bob');
  assert.equal(allResultsConsumed(), false);

  markResultConsumed('Carol');
  assert.equal(allResultsConsumed(), true);
}
console.log('  PASS');

// --- Cancel clears keep-codes ---

console.log('Test: cancelRally clears keep-codes');
{
  const { a, b } = setup3();
  a.setRoutineKeepCodes({ cooked_gudgeon: 5 });
  b.setRoutineKeepCodes({ cooked_gudgeon: 3 });

  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });

  cancelRally('test');
  assert.deepEqual(a.getRoutineKeepCodes(), {});
  assert.deepEqual(b.getRoutineKeepCodes(), {});
  assert.equal(isRallyActive(), false);
}
console.log('  PASS');

// --- Eligible contexts ---

console.log('Test: getEligibleContexts');
{
  _resetForTests();
  const a = makeCtx('Alice');
  const b = makeCtx('Bob', { cooldown: 5000 });
  const c = makeCtx('Carol', { full: true });
  registerContext(a);
  registerContext(b);
  registerContext(c);

  const eligible = getEligibleContexts({ enabledNames: ['Alice', 'Bob', 'Carol'] });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].name, 'Alice');
}
console.log('  PASS');

// --- Eligible excludes active rally participants ---

console.log('Test: getEligibleContexts excludes rally participants');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });

  const eligible = getEligibleContexts({ enabledNames: ['Alice', 'Bob', 'Carol'] });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].name, 'Carol');
}
console.log('  PASS');

// --- Repeat lifecycle ---

console.log('Test: repeat lifecycle');
{
  setup3();
  const rally1 = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });
  setFightResult({ fight: { result: 'win' } });
  setPhase('done');
  markResultConsumed('Alice');
  markResultConsumed('Bob');
  assert.equal(allResultsConsumed(), true);

  // Cancel old rally
  cancelRally('starting new rally');
  assert.equal(isRallyActive(), false);

  // Create new rally
  const rally2 = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });
  assert.ok(rally2);
  assert.equal(rally2.phase, 'rallying');
  assert.equal(allResultsConsumed(), false);
}
console.log('  PASS');

// --- resetForNextFight ---

console.log('Test: resetForNextFight resets check-ins and result, increments fightCount');
{
  setup3();
  const rally = tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob', 'Carol'],
  });
  assert.equal(rally.fightCount, 0);
  assert.equal(getFightCount(), 0);

  // Simulate a completed fight
  checkIn('Alice');
  checkIn('Bob');
  checkIn('Carol');
  setPhase('fighting');
  setFightResult({ fight: { result: 'win' } });
  setPhase('done');
  markResultConsumed('Alice');
  markResultConsumed('Bob');
  markResultConsumed('Carol');
  assert.equal(allResultsConsumed(), true);

  // Reset for next fight
  const ok = resetForNextFight();
  assert.equal(ok, true);
  const r = getRally();
  assert.equal(r.phase, 'rallying');
  assert.equal(r.fightCount, 1);
  assert.equal(getFightCount(), 1);
  assert.equal(r.fightResult, null);
  assert.equal(allCheckedIn(), false);
  assert.equal(allResultsConsumed(), false);
  // Team, location, loadouts preserved
  assert.equal(r.leaderName, 'Alice');
  assert.deepEqual(r.participants, ['Bob', 'Carol']);
  assert.deepEqual(r.location, { x: 1, y: 2 });
}
console.log('  PASS');

console.log('Test: resetForNextFight returns false when no rally');
{
  _resetForTests();
  assert.equal(resetForNextFight(), false);
  assert.equal(getFightCount(), 0);
}
console.log('  PASS');

console.log('Test: resetForNextFight resets TTL timer');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
    leaseTtlMs: 100,
  });
  const createdAt1 = getRally().createdAt;

  // Wait a bit, then reset
  await new Promise(r => setTimeout(r, 20));
  markResultConsumed('Alice');
  markResultConsumed('Bob');
  setPhase('done');
  resetForNextFight();

  const createdAt2 = getRally().createdAt;
  assert.ok(createdAt2 >= createdAt1 + 20, 'createdAt should be refreshed');
  // Rally should still be alive (TTL was reset)
  assert.equal(isRallyActive(), true);
}
console.log('  PASS');

console.log('Test: resetForNextFight preserves keep-codes');
{
  const { a, b } = setup3();
  a.setRoutineKeepCodes({ cooked_gudgeon: 5 });
  b.setRoutineKeepCodes({ cooked_gudgeon: 3 });

  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });
  setPhase('done');
  markResultConsumed('Alice');
  markResultConsumed('Bob');
  resetForNextFight();

  // Keep-codes should NOT be cleared (food still needed)
  assert.deepEqual(a.getRoutineKeepCodes(), { cooked_gudgeon: 5 });
  assert.deepEqual(b.getRoutineKeepCodes(), { cooked_gudgeon: 3 });
}
console.log('  PASS');

console.log('Test: multi-fight cycle with resetForNextFight');
{
  setup3();
  tryCreateRally({
    bossCode: 'king_slime',
    location: { x: 1, y: 2 },
    leaderName: 'Alice',
    participants: ['Bob'],
  });

  // Fight 1
  checkIn('Alice');
  checkIn('Bob');
  setPhase('done');
  setFightResult({ fight: { result: 'win', turns: 5 } });
  markResultConsumed('Alice');
  markResultConsumed('Bob');
  assert.equal(getFightCount(), 0);

  resetForNextFight();
  assert.equal(getFightCount(), 1);

  // Fight 2
  checkIn('Alice');
  checkIn('Bob');
  setPhase('done');
  setFightResult({ fight: { result: 'win', turns: 8 } });
  markResultConsumed('Alice');
  markResultConsumed('Bob');

  resetForNextFight();
  assert.equal(getFightCount(), 2);

  // Fight 3
  checkIn('Alice');
  checkIn('Bob');
  setPhase('done');
  setFightResult({ fight: { result: 'win', turns: 6 } });
  markResultConsumed('Alice');
  markResultConsumed('Bob');

  // Cancel after 3 fights
  cancelRally('reached fight limit');
  assert.equal(isRallyActive(), false);
  assert.equal(getFightCount(), 0); // no rally → 0
}
console.log('  PASS');

// --- registerEnabledBosses ---

console.log('Test: registerEnabledBosses and unregisterEnabledBosses');
{
  _resetForTests();
  const a = makeCtx('Alice');
  const b = makeCtx('Bob');
  registerContext(a);
  registerContext(b);

  registerEnabledBosses('Alice', ['king_slime', 'lich']);
  registerEnabledBosses('Bob', ['king_slime']);

  // Both eligible for king_slime
  const eligible1 = getEligibleContexts({ enabledNames: ['Alice', 'Bob'], bossCode: 'king_slime' });
  assert.equal(eligible1.length, 2);

  // Only Alice eligible for lich
  const eligible2 = getEligibleContexts({ enabledNames: ['Alice', 'Bob'], bossCode: 'lich' });
  assert.equal(eligible2.length, 1);
  assert.equal(eligible2[0].name, 'Alice');

  // No one eligible for goblin_priestess
  const eligible3 = getEligibleContexts({ enabledNames: ['Alice', 'Bob'], bossCode: 'goblin_priestess' });
  assert.equal(eligible3.length, 0);

  // Without bossCode filter, all eligible
  const eligible4 = getEligibleContexts({ enabledNames: ['Alice', 'Bob'] });
  assert.equal(eligible4.length, 2);

  // Unregister Alice's bosses
  unregisterEnabledBosses('Alice');
  const eligible5 = getEligibleContexts({ enabledNames: ['Alice', 'Bob'], bossCode: 'king_slime' });
  assert.equal(eligible5.length, 1);
  assert.equal(eligible5[0].name, 'Bob');
}
console.log('  PASS');

console.log('Test: unregisterContext also clears enabledBosses');
{
  _resetForTests();
  const a = makeCtx('Alice');
  registerContext(a);
  registerEnabledBosses('Alice', ['king_slime']);

  unregisterContext('Alice');
  // Re-register context without bosses — should not have boss filter data
  registerContext(a);
  const eligible = getEligibleContexts({ enabledNames: ['Alice'], bossCode: 'king_slime' });
  assert.equal(eligible.length, 0); // no enabled bosses registered
}
console.log('  PASS');

console.log('Test: _resetForTests clears enabledBosses');
{
  const a = makeCtx('Alice');
  _resetForTests();
  registerContext(a);
  registerEnabledBosses('Alice', ['king_slime']);

  _resetForTests();
  registerContext(a);
  const eligible = getEligibleContexts({ enabledNames: ['Alice'], bossCode: 'king_slime' });
  assert.equal(eligible.length, 0);
}
console.log('  PASS');

console.log('\nAll boss-rally tests passed!');
