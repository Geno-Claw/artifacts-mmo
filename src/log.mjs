/**
 * Simple timestamped logging with optional subscribers.
 *
 * Set LOG_LEVEL=debug in .env (or at launch) to enable debug-level output.
 */

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, stat: 1, warn: 2, error: 3 };
const activeLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

const sinks = new Set();

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function emit(level, msg, detail = '') {
  const at = Date.now();
  const suffix = detail ? ` — ${detail}` : '';

  if (level === 'warn') {
    const line = `[${ts()}] WARN: ${msg}${suffix}`;
    console.warn(line);
    publish({ level, msg: `${msg}${suffix}`, line, at });
    return;
  }

  if (level === 'error') {
    const line = `[${ts()}] ERROR: ${msg}${suffix}`;
    console.error(line);
    publish({ level, msg: `${msg}${suffix}`, line, at });
    return;
  }

  if (level === 'stat') {
    const line = `[${ts()}]   ${msg}${suffix}`;
    console.log(line);
    publish({ level, msg: `${msg}${suffix}`, line, at });
    return;
  }

  const line = `[${ts()}] ${msg}${suffix}`;
  console.log(line);
  publish({ level: 'info', msg: `${msg}${suffix}`, line, at });
}

function publish(entry) {
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // Logging sinks should never crash the runtime.
    }
  }
}

export function subscribeLogEvents(listener) {
  if (typeof listener !== 'function') {
    throw new Error('subscribeLogEvents(listener) requires a function');
  }
  sinks.add(listener);
  return () => sinks.delete(listener);
}

export function debug(msg) {
  if (activeLevel > 0) return;
  emit('debug', msg);
}

export function info(msg) {
  emit('info', msg);
}

export function warn(msg) {
  emit('warn', msg);
}

export function error(msg, detail = '') {
  emit('error', msg, detail);
}

export function stat(label, value) {
  emit('stat', `${label}: ${value}`);
}
