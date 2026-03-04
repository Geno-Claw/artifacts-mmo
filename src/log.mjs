/**
 * Structured logging with compatibility helpers.
 *
 * Backward-compatible API:
 * - log.debug(msg)
 * - log.info(msg)
 * - log.warn(msg)
 * - log.error(msg, detail?)
 * - log.stat(label, value)
 *
 * New API:
 * - createLogger(baseContext).info(msg, meta)
 * - logger.child(extraContext)
 *
 * Environment:
 * - LOG_LEVEL=debug|info|warn|error|stat (default: info)
 * - LOG_OUTPUT=console,jsonl (default: console,jsonl)
 * - LOG_DIR=./report/logs (default)
 * - LOG_DEBUG_SCOPES=scheduler,api,... (optional; filters debug logs)
 */

import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { getLogContext } from './log-context.mjs';

const LOG_LEVEL = `${process.env.LOG_LEVEL || 'info'}`.trim().toLowerCase();
const LEVELS = Object.freeze({
  debug: 0,
  info: 1,
  stat: 1,
  warn: 2,
  error: 3,
});
const activeLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

const LOG_OUTPUT = `${process.env.LOG_OUTPUT || 'console,jsonl'}`.trim();
const LOG_DIR = `${process.env.LOG_DIR || './report/logs'}`.trim() || './report/logs';
const DEBUG_SCOPE_FILTER = `${process.env.LOG_DEBUG_SCOPES || ''}`.trim();

const outputSet = new Set(
  LOG_OUTPUT
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
);
if (outputSet.size === 0) {
  outputSet.add('console');
}

const debugScopes = new Set(
  DEBUG_SCOPE_FILTER
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

const sinks = new Set();
let jsonlInitDone = false;
let jsonlDisabled = false;
let jsonlErrorPrinted = false;
let jsonlWriteChain = Promise.resolve();

const MAX_DEPTH = 5;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;
const MAX_KEYS = 80;

const META_RESERVED_KEYS = new Set([
  'detail',
  'context',
  'scope',
  'event',
  'reasonCode',
  'data',
  'error',
]);

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function ts(atMs = Date.now()) {
  return new Date(atMs).toLocaleTimeString('en-US', { hour12: false });
}

function trimString(value, maxLen = MAX_STRING) {
  const text = `${value ?? ''}`;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function sanitizeError(err, depth = 0, seen = new WeakSet()) {
  if (err == null) return null;
  if (typeof err === 'string') {
    return { message: trimString(err) };
  }
  if (typeof err !== 'object') {
    return { message: trimString(err) };
  }
  if (seen.has(err)) return { message: '[CircularError]' };
  seen.add(err);

  const message = trimString(err.message || String(err));
  const out = { message };

  if (err.code != null) out.code = trimString(err.code);
  if (Number.isFinite(Number(err.status))) out.status = Number(err.status);
  if (err.stack) out.stack = trimString(err.stack, 6_000);
  if (isObject(err.data) && depth < MAX_DEPTH) {
    out.data = sanitizeValue(err.data, depth + 1, seen);
  }

  return out;
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === 'string') return trimString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value, depth, seen);

  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (typeof value !== 'object') return trimString(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY).map(v => sanitizeValue(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) capped.push(`[+${value.length - MAX_ARRAY} more]`);
    return capped;
  }

  const out = {};
  const entries = Object.entries(value).slice(0, MAX_KEYS);
  for (const [key, val] of entries) {
    out[key] = sanitizeValue(val, depth + 1, seen);
  }
  if (Object.keys(value).length > MAX_KEYS) {
    out.__truncated_keys__ = Object.keys(value).length - MAX_KEYS;
  }
  return out;
}

function normalizeMeta(meta) {
  if (meta == null) {
    return {
      detail: '',
      scope: null,
      event: null,
      reasonCode: null,
      context: null,
      data: null,
      error: null,
    };
  }

  if (typeof meta === 'string') {
    return {
      detail: meta,
      scope: null,
      event: null,
      reasonCode: null,
      context: null,
      data: null,
      error: null,
    };
  }

  if (meta instanceof Error) {
    return {
      detail: '',
      scope: null,
      event: null,
      reasonCode: null,
      context: null,
      data: null,
      error: meta,
    };
  }

  if (!isObject(meta)) {
    return {
      detail: `${meta}`,
      scope: null,
      event: null,
      reasonCode: null,
      context: null,
      data: null,
      error: null,
    };
  }

  const out = {
    detail: typeof meta.detail === 'string' ? meta.detail : '',
    scope: typeof meta.scope === 'string' ? meta.scope : null,
    event: typeof meta.event === 'string' ? meta.event : null,
    reasonCode: typeof meta.reasonCode === 'string' ? meta.reasonCode : null,
    context: isObject(meta.context) ? { ...meta.context } : null,
    data: Object.prototype.hasOwnProperty.call(meta, 'data') ? meta.data : null,
    error: meta.error instanceof Error
      ? meta.error
      : (meta.error ? new Error(trimString(meta.error)) : null),
  };

  if (out.data == null) {
    const extra = {};
    for (const [key, value] of Object.entries(meta)) {
      if (META_RESERVED_KEYS.has(key)) continue;
      extra[key] = value;
    }
    if (Object.keys(extra).length > 0) {
      out.data = extra;
    }
  }

  return out;
}

function shouldEmit(level, scope) {
  const levelRank = LEVELS[level] ?? LEVELS.info;
  if (levelRank < activeLevel) return false;

  if (level === 'debug' && debugScopes.size > 0) {
    const scopeText = `${scope || ''}`.trim();
    if (!scopeText) return false;
    for (const allowed of debugScopes) {
      if (scopeText === allowed || scopeText.startsWith(`${allowed}.`) || scopeText.startsWith(`${allowed}:`)) {
        return true;
      }
    }
    return false;
  }

  return true;
}

function buildCompatibilityMsg(message, detail = '') {
  if (!detail) return message;
  return `${message} — ${detail}`;
}

function formatConsoleLine(level, msg, atMs) {
  const time = ts(atMs);
  if (level === 'warn') return `[${time}] WARN: ${msg}`;
  if (level === 'error') return `[${time}] ERROR: ${msg}`;
  if (level === 'stat') return `[${time}]   ${msg}`;
  return `[${time}] ${msg}`;
}

function ensureJsonlReady() {
  if (jsonlInitDone || jsonlDisabled) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    jsonlInitDone = true;
  } catch (err) {
    jsonlDisabled = true;
    if (!jsonlErrorPrinted) {
      jsonlErrorPrinted = true;
      console.error(`[log] JSONL disabled (mkdir failed for ${LOG_DIR}): ${err?.message || String(err)}`);
    }
  }
}

function writeJsonl(entry) {
  if (!outputSet.has('jsonl') || jsonlDisabled) return;

  ensureJsonlReady();
  if (jsonlDisabled) return;

  const day = entry.iso.slice(0, 10);
  const targetFile = pathJoin(LOG_DIR, `runtime-${day}.jsonl`);
  const line = `${JSON.stringify(entry)}\n`;

  jsonlWriteChain = jsonlWriteChain
    .catch(() => {
      // Prior write failure already reported.
    })
    .then(async () => {
      try {
        await appendFile(targetFile, line, 'utf-8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          try {
            mkdirSync(LOG_DIR, { recursive: true });
            jsonlInitDone = true;
            await appendFile(targetFile, line, 'utf-8');
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
        if (!jsonlErrorPrinted) {
          jsonlErrorPrinted = true;
          console.error(`[log] JSONL write failed (${targetFile}): ${err?.message || String(err)}`);
        }
      }
    });
}

function publish(entry) {
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // Logging sinks should never crash runtime.
    }
  }
}

function emitEntry(entry) {
  if (outputSet.has('console')) {
    if (entry.level === 'warn') {
      console.warn(entry.line);
    } else if (entry.level === 'error') {
      console.error(entry.line);
    } else {
      console.log(entry.line);
    }
  }

  writeJsonl(entry);
  publish(entry);
}

function coerceMessage(message) {
  if (typeof message === 'string') return message;
  if (message == null) return '';
  return trimString(message);
}

function createEntry(level, message, meta, baseContext = {}) {
  const rawMessage = coerceMessage(message);
  const parsed = normalizeMeta(meta);

  const mergedContext = sanitizeValue({
    ...getLogContext(),
    ...baseContext,
    ...(parsed.context || {}),
  });

  const scope = parsed.scope || mergedContext?.scope || null;
  if (!shouldEmit(level, scope)) return null;

  const atMs = Date.now();
  const iso = new Date(atMs).toISOString();
  const detail = trimString(parsed.detail || '');
  const compatMsg = buildCompatibilityMsg(rawMessage, detail);
  const line = formatConsoleLine(level, compatMsg, atMs);
  const error = parsed.error ? sanitizeError(parsed.error) : null;

  const entry = {
    atMs,
    at: atMs, // compatibility
    iso,
    level,
    message: rawMessage,
    msg: compatMsg, // compatibility
    line, // compatibility
    scope,
    event: parsed.event || null,
    reasonCode: parsed.reasonCode || null,
    context: isObject(mergedContext) ? mergedContext : {},
    data: sanitizeValue(parsed.data),
    error,
  };

  return entry;
}

function createLogger(baseContext = {}) {
  const rootContext = isObject(baseContext) ? { ...baseContext } : {};

  function emit(level, message, meta = null) {
    const entry = createEntry(level, message, meta, rootContext);
    if (!entry) return;
    emitEntry(entry);
  }

  return {
    child(extraContext = {}) {
      return createLogger({
        ...rootContext,
        ...(isObject(extraContext) ? extraContext : {}),
      });
    },
    debug(message, meta = null) {
      emit('debug', message, meta);
    },
    info(message, meta = null) {
      emit('info', message, meta);
    },
    warn(message, meta = null) {
      emit('warn', message, meta);
    },
    error(message, meta = null) {
      emit('error', message, meta);
    },
    stat(label, value, meta = null) {
      emit('stat', `${coerceMessage(label)}: ${coerceMessage(value)}`, meta);
    },
  };
}

const rootLogger = createLogger();

export function subscribeLogEvents(listener) {
  if (typeof listener !== 'function') {
    throw new Error('subscribeLogEvents(listener) requires a function');
  }
  sinks.add(listener);
  return () => sinks.delete(listener);
}

export function debug(msg, meta = null) {
  rootLogger.debug(msg, meta);
}

export function info(msg, meta = null) {
  rootLogger.info(msg, meta);
}

export function warn(msg, meta = null) {
  rootLogger.warn(msg, meta);
}

export function error(msg, detail = '') {
  if (typeof detail === 'string' || detail == null || detail instanceof Error) {
    rootLogger.error(msg, detail);
    return;
  }
  rootLogger.error(msg, detail);
}

export function stat(label, value, meta = null) {
  rootLogger.stat(label, value, meta);
}

export { createLogger };
