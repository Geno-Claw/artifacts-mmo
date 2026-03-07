#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { prepareConfigForSave } from '../src/services/config-store.mjs';

function loadConfigEditorInternals() {
  const source = readFileSync(new URL('../frontend/js/config-editor.js', import.meta.url), 'utf-8');
  const sandbox = {
    console,
    structuredClone,
    modalState: {
      configOptions: null,
      configDraft: null,
    },
    safeText(value, fallback = '') {
      const text = `${value ?? ''}`.trim();
      return text || fallback;
    },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, {
    filename: 'frontend/js/config-editor.js',
  });
  return sandbox.__configEditorInternals;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testPrepareConfigForSaveMaterializesManagedTemplate() {
  const input = {
    characters: [
      {
        name: 'Alpha',
        routines: [
          {
            type: 'skillRotation',
            weights: { combat: 1 },
            taskCollection: { tasks_coin: 8 },
          },
          {
            type: 'gatherResource',
            resource: 'copper_rocks',
            priority: 10,
          },
        ],
      },
    ],
  };

  const { config } = await prepareConfigForSave(input);
  const routines = config.characters[0].routines;
  assert.deepEqual(
    routines.slice(0, 7).map((entry) => entry.type),
    ['rest', 'depositBank', 'bankExpansion', 'event', 'completeTask', 'orderFulfillment', 'skillRotation'],
    'prepareConfigForSave should materialize the managed routine template in canonical order',
  );
  assert.equal(
    routines.find((entry) => entry.type === 'event')?.enabled,
    false,
    'missing toggleable routines should materialize with enabled=false',
  );
  assert.equal(
    routines.find((entry) => entry.type === 'gatherResource')?.resource,
    'copper_rocks',
    'unsupported routines should be preserved after the managed block',
  );
  assert.deepEqual(
    routines.find((entry) => entry.type === 'skillRotation')?.taskCollection,
    { tasks_coin: 8 },
    'raw-only skill rotation collections should be preserved during save normalization',
  );
}

function testConfigEditorRawRoundTripAndCharacterMapping(internals) {
  const rawText = JSON.stringify({
    combat: {
      winRateThreshold: 92,
    },
    characters: [
      { name: 'Alpha', routines: [{ type: 'rest' }] },
      { name: 'Beta', routines: [{ type: 'skillRotation', enabled: true }] },
    ],
  });

  const parsed = internals.parseConfigEditorRawText(rawText);
  assert.equal(parsed.ok, true, 'raw parser should accept valid config JSON');
  assert.deepEqual(
    Array.from(internals.getConfigEditorCharacterNames(parsed.value)),
    ['Alpha', 'Beta'],
    'character mapping helper should derive character names from the parsed draft',
  );

  const stringified = internals.stringifyConfigEditorDraft(parsed.value);
  const reparsed = internals.parseConfigEditorRawText(stringified);
  assert.equal(reparsed.ok, true, 'stringified draft should parse again');
  assert.equal(reparsed.value.combat.winRateThreshold, 92, 'top-level combat block should survive raw round-trip');
  assert.equal(reparsed.value.characters[1].name, 'Beta');
}

function testStructuredWritePreservesUnsupportedFields(internals) {
  const draft = {
    characters: [
      {
        name: 'Alpha',
        routines: [
          {
            type: 'skillRotation',
            enabled: true,
            taskCollection: {
              rare_item: 2,
            },
          },
        ],
      },
    ],
  };

  const nextDraft = deepClone(draft);
  const routine = internals.ensureConfigEditorRoutineNode(nextDraft, 'Alpha', 'skillRotation');
  assert.ok(routine, 'should resolve the target routine');
  internals.setConfigEditorPathValue(routine, 'enabled', false);

  assert.equal(routine.enabled, false, 'structured write should update the requested field');
  assert.deepEqual(
    routine.taskCollection,
    { rare_item: 2 },
    'structured write should preserve raw-only fields on the same routine object',
  );
}

function testStructuredWriteSupportsGlobalCombatThreshold(internals) {
  const draft = {
    combat: {
      winRateThreshold: 90,
    },
    characters: [
      {
        name: 'Alpha',
        routines: [{ type: 'event', enabled: true, monsterEvents: true }],
      },
    ],
  };

  const nextDraft = deepClone(draft);
  internals.setConfigEditorPathValue(nextDraft, 'combat.winRateThreshold', 87);

  assert.equal(nextDraft.combat.winRateThreshold, 87, 'structured write should update the global combat threshold');
  assert.equal(
    nextDraft.characters[0].routines[0].monsterEvents,
    true,
    'updating the global combat threshold should not disturb routine config',
  );
}

function testRawParseFailure(internals) {
  const parsed = internals.parseConfigEditorRawText('{"characters": [');
  assert.equal(parsed.ok, false, 'raw parser should reject malformed JSON');
  assert.equal(typeof parsed.error, 'string');
  assert.ok(parsed.error.length > 0, 'raw parser should include a parse error message');
}

async function run() {
  const internals = loadConfigEditorInternals();
  assert.ok(internals, 'config editor internals should be exposed for tests');

  await testPrepareConfigForSaveMaterializesManagedTemplate();
  testConfigEditorRawRoundTripAndCharacterMapping(internals);
  testStructuredWritePreservesUnsupportedFields(internals);
  testStructuredWriteSupportsGlobalCombatThreshold(internals);
  testRawParseFailure(internals);

  console.log('test-config-editor: PASS');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
