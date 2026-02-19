#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfigSnapshot,
  saveConfigAtomically,
  validateBotConfig,
} from '../src/services/config-store.mjs';

function assertHasKeys(obj, keys, label) {
  assert.ok(obj && typeof obj === 'object', `${label} must be an object`);
  for (const key of keys) {
    assert.equal(Object.hasOwn(obj, key), true, `${label} missing key "${key}"`);
  }
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutateConfigName(config, suffix) {
  const next = deepCloneJson(config);
  assert.ok(Array.isArray(next.characters), 'config.characters must be an array');
  assert.ok(next.characters.length > 0, 'config.characters must not be empty');
  const first = next.characters[0] || {};
  const baseName = `${first.name || 'TestCharacter'}`.trim() || 'TestCharacter';
  next.characters[0] = {
    ...first,
    name: `${baseName}_${suffix}`,
  };
  return next;
}

function readTextFromFd(fd) {
  const stat = fs.fstatSync(fd);
  const size = Number(stat.size) || 0;
  if (size <= 0) return '';
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, 0);
  return buf.toString('utf-8');
}

function openAtomicProbe(configPath) {
  const fd = fs.openSync(configPath, 'r');
  return {
    fd,
    inode: fs.fstatSync(fd).ino,
    text: readTextFromFd(fd),
    close() {
      fs.closeSync(fd);
    },
  };
}

function assertAtomicReplaceBehavior(configPath, probe) {
  const currentStat = fs.statSync(configPath);
  assert.notEqual(
    currentStat.ino,
    probe.inode,
    'save should replace config via rename (inode should change)',
  );
  assert.equal(
    readTextFromFd(probe.fd),
    probe.text,
    'pre-save descriptor should keep seeing old bytes after atomic rename',
  );
}

function assertValidationErrorsShape(errors, label = 'validation errors') {
  assert.ok(Array.isArray(errors), `${label} must be an array`);
  assert.ok(errors.length > 0, `${label} must not be empty`);
  for (const [idx, entry] of errors.entries()) {
    assertHasKeys(entry, ['path', 'message'], `${label}[${idx}]`);
    assert.equal(typeof entry.path, 'string', `${label}[${idx}].path must be a string`);
    assert.equal(typeof entry.message, 'string', `${label}[${idx}].message must be a string`);
    assert.ok(entry.message.length > 0, `${label}[${idx}].message must not be empty`);
  }
}

async function run() {
  const rootDir = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const tempDir = mkdtempSync(join(tmpdir(), 'config-store-test-'));
  const configPath = join(tempDir, 'characters.json');
  const schemaPath = resolve(rootDir, 'config/characters.schema.json');
  const sourceConfigPath = resolve(rootDir, 'config/characters-local.json');
  copyFileSync(sourceConfigPath, configPath);

  const snapshotOpts = {
    cwd: rootDir,
    botConfigPath: configPath,
  };
  const validationOpts = {
    cwd: rootDir,
    schemaPath,
  };

  try {
    const initial = await loadConfigSnapshot(snapshotOpts);
    assertHasKeys(initial, ['path', 'resolvedPath', 'hash', 'config'], 'loadConfigSnapshot result');
    assert.equal(typeof initial.path, 'string');
    assert.equal(typeof initial.resolvedPath, 'string');
    assert.equal(typeof initial.hash, 'string');

    const valid = await validateBotConfig(initial.config, validationOpts);
    assert.equal(valid.ok, true, 'valid config should return ok=true');
    assert.ok(Array.isArray(valid.errors), 'valid config response should include errors array');
    assert.equal(valid.errors.length, 0, 'valid config should return empty errors array');

    const invalid = await validateBotConfig({ characters: [{ name: 'MissingRoutines' }] }, validationOpts);
    assert.equal(invalid.ok, false, 'invalid config should return ok=false');
    assertValidationErrorsShape(invalid.errors, 'invalid config errors');

    const updatedConfig = mutateConfigName(initial.config, 'serviceAtomicSave');
    const atomicProbe = openAtomicProbe(configPath);
    let saveResult;
    try {
      saveResult = await saveConfigAtomically(updatedConfig, snapshotOpts);
      assertAtomicReplaceBehavior(configPath, atomicProbe);
    } finally {
      atomicProbe.close();
    }

    assertHasKeys(saveResult, ['path', 'resolvedPath', 'hash', 'savedAtMs'], 'saveConfigAtomically result');
    assert.equal(typeof saveResult.hash, 'string');
    assert.equal(typeof saveResult.savedAtMs, 'number');

    const savedDiskConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(
      savedDiskConfig?.characters?.[0]?.name,
      updatedConfig?.characters?.[0]?.name,
      'save should persist updated config to disk',
    );

    console.log('test-config-store: PASS');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
