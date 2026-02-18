#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SEARCH_DIRS = ['src', 'scripts'];
const ALLOWED = new Set([
  path.normalize('src/api.mjs'),
  path.normalize('src/services/bank-ops.mjs'),
]);
const DIRECT_BANK_CALL_RE = /\bapi\.(depositBank|withdrawBank|depositGold|withdrawGold)\s*\(/g;

function walk(dir, out = []) {
  if (!statSync(dir).isDirectory()) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!full.endsWith('.mjs') && !full.endsWith('.js')) continue;
    out.push(full);
  }
  return out;
}

function lineAndColumn(source, index) {
  const upTo = source.slice(0, index);
  const lines = upTo.split('\n');
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

const violations = [];

for (const relDir of SEARCH_DIRS) {
  const absDir = path.join(ROOT, relDir);
  let files = [];
  try {
    files = walk(absDir);
  } catch {
    continue;
  }

  for (const absFile of files) {
    const relFile = path.normalize(path.relative(ROOT, absFile));
    if (ALLOWED.has(relFile)) continue;

    const source = readFileSync(absFile, 'utf8');
    DIRECT_BANK_CALL_RE.lastIndex = 0;

    let match;
    while ((match = DIRECT_BANK_CALL_RE.exec(source)) !== null) {
      const pos = lineAndColumn(source, match.index);
      violations.push({ file: relFile, line: pos.line, column: pos.column, call: match[1] });
    }
  }
}

if (violations.length > 0) {
  console.error('Direct bank API calls are not allowed outside src/api.mjs and src/services/bank-ops.mjs:');
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line}:${v.column} uses api.${v.call}(...)`);
  }
  process.exit(1);
}

console.log('no-direct-bank-api test passed');
