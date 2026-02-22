import WebSocket from 'ws';
import * as log from '../log.mjs';

const TAG = '[WebSocket]';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let ws = null;
let config = null;
let intentionalClose = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastConnectedAt = null;
let lastErrorAt = null;

/** @type {Map<string, Set<Function>>} */
const typeSubscribers = new Map();

/** @type {Set<Function>} */
const allSubscribers = new Set();

function dispatch(type, data) {
  const handlers = typeSubscribers.get(type);
  if (handlers) {
    for (const fn of handlers) {
      try { fn(data, type); } catch (err) {
        log.warn(`${TAG} Subscriber error for "${type}": ${err?.message || String(err)}`);
      }
    }
  }
  for (const fn of allSubscribers) {
    try { fn(data, type); } catch (err) {
      log.warn(`${TAG} Subscriber error (all): ${err?.message || String(err)}`);
    }
  }
}

function onOpen() {
  log.info(`${TAG} Connected to ${config.url}`);
  reconnectAttempts = 0;
  lastConnectedAt = Date.now();

  const authMsg = { token: config.token };
  if (config.subscriptions) authMsg.subscriptions = config.subscriptions;
  ws.send(JSON.stringify(authMsg));
}

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log.warn(`${TAG} Failed to parse message: ${String(raw).slice(0, 200)}`);
    return;
  }

  const { type, data } = msg;
  if (!type) {
    log.warn(`${TAG} Message missing type field`);
    return;
  }

  dispatch(type, data);
}

function onError(err) {
  lastErrorAt = Date.now();
  log.warn(`${TAG} Error: ${err?.message || String(err)}`);
}

function onClose(code, reason) {
  const reasonStr = reason ? Buffer.from(reason).toString() : '';
  log.info(`${TAG} Disconnected (code=${code}${reasonStr ? `, reason=${reasonStr}` : ''})`);

  ws = null;

  if (!intentionalClose && config) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delayMs = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_MS,
  );
  reconnectAttempts++;

  log.info(`${TAG} Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (intentionalClose || !config) return;
    connect();
  }, delayMs);
}

function connect() {
  if (ws) return;

  try {
    ws = new WebSocket(config.url);
    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  } catch (err) {
    log.warn(`${TAG} Connection failed: ${err?.message || String(err)}`);
    ws = null;
    scheduleReconnect();
  }
}

export async function initialize({ url, token, subscriptions = null }) {
  if (!url || !token) {
    throw new Error('WebSocket client requires url and token');
  }

  await cleanup();

  config = { url, token, subscriptions };
  intentionalClose = false;
  reconnectAttempts = 0;

  connect();
}

export async function cleanup() {
  intentionalClose = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    try {
      ws.close(1000, 'shutdown');
    } catch {
      // ignore
    }
    ws = null;
  }

  config = null;
  reconnectAttempts = 0;
}

export function subscribe(eventType, handler) {
  if (typeof handler !== 'function') {
    throw new Error('subscribe(eventType, handler) requires a function');
  }
  let set = typeSubscribers.get(eventType);
  if (!set) {
    set = new Set();
    typeSubscribers.set(eventType, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) typeSubscribers.delete(eventType);
  };
}

export function subscribeAll(handler) {
  if (typeof handler !== 'function') {
    throw new Error('subscribeAll(handler) requires a function');
  }
  allSubscribers.add(handler);
  return () => allSubscribers.delete(handler);
}

export function getState() {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    reconnectAttempts,
    lastConnectedAt,
    lastErrorAt,
  };
}
