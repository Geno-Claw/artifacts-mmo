#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), 'log-test-'));
  const previous = {
    LOG_OUTPUT: process.env.LOG_OUTPUT,
    LOG_DIR: process.env.LOG_DIR,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };

  process.env.LOG_OUTPUT = 'jsonl';
  process.env.LOG_DIR = tempDir;
  process.env.LOG_LEVEL = 'debug';

  try {
    const mod = await import(`../src/log.mjs?test=${Date.now()}`);
    const {
      createLogger,
      formatEntryConsoleLine,
      formatEntryMessage,
      _flushJsonlForTests,
    } = mod;

    const logger = createLogger({ scope: 'test.logger' });
    logger.info('[Alpha] structured info', {
      detail: 'with detail',
      event: 'test.log.info',
      reasonCode: 'test_reason',
      context: {
        character: 'Alpha',
        scope: 'ignored.scope',
      },
      data: {
        foo: 'bar',
      },
    });

    logger.error('Structured error', {
      event: 'test.log.error',
      error: Object.assign(new Error('boom'), { code: 'E_TEST' }),
      context: {
        character: 'Alpha',
      },
    });

    await _flushJsonlForTests();

    const day = new Date().toISOString().slice(0, 10);
    const target = join(tempDir, `runtime-${day}.jsonl`);
    const entries = readFileSync(target, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    assert.equal(entries.length, 2, 'expected two canonical JSONL entries');

    const infoEntry = entries[0];
    assert.equal(infoEntry.message, '[Alpha] structured info');
    assert.equal(infoEntry.detail, 'with detail');
    assert.equal(infoEntry.scope, 'test.logger');
    assert.equal(infoEntry.event, 'test.log.info');
    assert.equal(infoEntry.reasonCode, 'test_reason');
    assert.deepEqual(infoEntry.context, { character: 'Alpha' }, 'scope should not be duplicated into context');
    assert.deepEqual(infoEntry.data, { foo: 'bar' });
    assert.equal(Object.hasOwn(infoEntry, 'msg'), false, 'JSONL should not persist msg');
    assert.equal(Object.hasOwn(infoEntry, 'line'), false, 'JSONL should not persist line');
    assert.equal(Object.hasOwn(infoEntry, 'at'), false, 'JSONL should not persist at');
    assert.equal(formatEntryMessage(infoEntry), '[Alpha] structured info — with detail');

    const renderedLine = formatEntryConsoleLine(infoEntry);
    assert.equal(renderedLine.includes('with detail'), true, 'console line should include detail');
    assert.equal(renderedLine.includes('[Alpha] structured info'), true, 'console line should include message');

    const errorEntry = entries[1];
    assert.equal(errorEntry.event, 'test.log.error');
    assert.equal(errorEntry.error?.message, 'boom');
    assert.equal(errorEntry.error?.code, 'E_TEST');

    console.log('test-log: PASS');
  } finally {
    if (previous.LOG_OUTPUT === undefined) delete process.env.LOG_OUTPUT;
    else process.env.LOG_OUTPUT = previous.LOG_OUTPUT;
    if (previous.LOG_DIR === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previous.LOG_DIR;
    if (previous.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous.LOG_LEVEL;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
