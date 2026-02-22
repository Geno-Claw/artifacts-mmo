/**
 * Event Manager — tracks active game events via WebSocket + REST catch-up.
 *
 * Singleton service. Subscribes to event_spawn / event_removed WebSocket
 * messages for real-time updates. On initialize, fetches current active
 * events via REST to catch anything that spawned before we connected.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { subscribe as wsSubscribe } from './websocket-client.mjs';

const TAG = '[EventManager]';

const EXPIRY_BUFFER_MS = 30_000; // Consider events "expired" 30s before actual expiry

// --- Module-level state (singleton) ---

/** @type {Map<string, object>} eventCode → definition from GET /events */
let eventDefinitions = new Map();

/** @type {Map<string, { code, contentType, contentCode, map, expiration, createdAt }>} */
let activeEvents = new Map();

let initialized = false;
let unsubSpawn = null;
let unsubRemoved = null;

// --- WebSocket handlers ---

function handleEventSpawn(data) {
  if (!data) return;

  const contentCode = data.content?.code || data.map?.content?.code;
  const contentType = data.content?.type || data.map?.content?.type;
  if (!contentCode) {
    log.warn(`${TAG} event_spawn missing content code`);
    return;
  }

  const entry = {
    code: contentCode,
    contentType: contentType || null,
    contentCode,
    map: data.map ? { x: data.map.x, y: data.map.y } : null,
    expiration: data.expiration ? new Date(data.expiration) : null,
    createdAt: data.created_at ? new Date(data.created_at) : null,
  };

  activeEvents.set(contentCode, entry);

  const loc = entry.map ? `(${entry.map.x},${entry.map.y})` : '?';
  const expires = entry.expiration ? entry.expiration.toISOString() : '?';
  log.info(`${TAG} Event spawned: ${contentCode} [${contentType}] at ${loc}, expires ${expires}`);
}

function handleEventRemoved(data) {
  if (!data) return;

  const contentCode = data.content?.code || data.map?.content?.code;
  if (!contentCode) {
    log.warn(`${TAG} event_removed missing content code`);
    return;
  }

  const existed = activeEvents.delete(contentCode);
  if (existed) {
    log.info(`${TAG} Event removed: ${contentCode}`);
  }
}

// --- Initialization ---

export async function initialize() {
  // 1. Load event definitions (static per season)
  try {
    const defs = await loadAllPages(api.getEvents);
    eventDefinitions = new Map();
    for (const def of defs) {
      eventDefinitions.set(def.code, def);
    }
    log.info(`${TAG} Loaded ${eventDefinitions.size} event definitions`);
  } catch (err) {
    log.warn(`${TAG} Could not load event definitions: ${err.message}`);
  }

  // 2. Catch-up: fetch currently active events (spawned before we connected)
  try {
    const active = await loadAllPages(api.getActiveEvents);
    for (const evt of active) {
      const contentCode = evt.content?.code || evt.map?.content?.code;
      if (!contentCode) continue;
      const contentType = evt.content?.type || evt.map?.content?.type;
      activeEvents.set(contentCode, {
        code: contentCode,
        contentType: contentType || null,
        contentCode,
        map: evt.map ? { x: evt.map.x, y: evt.map.y } : null,
        expiration: evt.expiration ? new Date(evt.expiration) : null,
        createdAt: evt.created_at ? new Date(evt.created_at) : null,
      });
    }
    if (activeEvents.size > 0) {
      const codes = [...activeEvents.keys()].join(', ');
      log.info(`${TAG} Caught up ${activeEvents.size} active event(s): ${codes}`);
    }
  } catch (err) {
    log.warn(`${TAG} Could not fetch active events: ${err.message}`);
  }

  // 3. Subscribe to WebSocket events
  unsubSpawn = wsSubscribe('event_spawn', handleEventSpawn);
  unsubRemoved = wsSubscribe('event_removed', handleEventRemoved);

  initialized = true;
  log.info(`${TAG} Initialized`);
}

export async function cleanup() {
  if (unsubSpawn) { unsubSpawn(); unsubSpawn = null; }
  if (unsubRemoved) { unsubRemoved(); unsubRemoved = null; }
  activeEvents.clear();
  eventDefinitions.clear();
  initialized = false;
}

// --- Query API ---

/**
 * Returns active monster events with sufficient time remaining.
 * Each entry: { code, contentType, contentCode, map, expiration, createdAt, definition }
 */
export function getActiveMonsterEvents() {
  return getActiveByType('monster');
}

export function getActiveResourceEvents() {
  return getActiveByType('resource');
}

export function getActiveNpcEvents() {
  return getActiveByType('npc');
}

function getActiveByType(type) {
  const now = Date.now();
  const results = [];
  for (const entry of activeEvents.values()) {
    if (entry.contentType !== type) continue;
    if (entry.expiration && entry.expiration.getTime() - now < EXPIRY_BUFFER_MS) continue;
    results.push({
      ...entry,
      definition: eventDefinitions.get(entry.code) || null,
    });
  }
  return results;
}

/** Check if a specific event is still active (with expiry buffer). */
export function isEventActive(code) {
  const entry = activeEvents.get(code);
  if (!entry) return false;
  if (!entry.expiration) return true;
  return entry.expiration.getTime() - Date.now() > EXPIRY_BUFFER_MS;
}

/** Returns ms until the event expires, or 0 if expired/not found. */
export function getTimeRemaining(code) {
  const entry = activeEvents.get(code);
  if (!entry?.expiration) return 0;
  return Math.max(0, entry.expiration.getTime() - Date.now());
}

/** Returns the static event definition, or null. */
export function getEventDefinition(code) {
  return eventDefinitions.get(code) || null;
}

/** Returns the active event entry, or null. */
export function getActiveEvent(code) {
  return activeEvents.get(code) || null;
}

// --- Helpers ---

async function loadAllPages(apiFn) {
  const all = [];
  let page = 1;
  while (true) {
    const result = await apiFn({ page, size: 100 });
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

/** Returns content codes for all NPC-type events (for catalog preloading). */
export function getNpcEventCodes() {
  const codes = [];
  for (const def of eventDefinitions.values()) {
    if (def.content?.type === 'npc' && def.content?.code) {
      codes.push(def.content.code);
    }
  }
  return codes;
}

// --- Testing helpers ---

export { handleEventSpawn as _handleEventSpawn, handleEventRemoved as _handleEventRemoved };
export { activeEvents as _activeEvents, eventDefinitions as _eventDefinitions };
