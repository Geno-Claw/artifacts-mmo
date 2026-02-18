/**
 * Live dashboard UI state.
 * Keeps a fixed roster from BOT_CONFIG and emits change notifications.
 */

const DEFAULT_STALE_AFTER_MS = 45_000;
const DEFAULT_LOG_LIMIT = 20;

let uiMeta = {
  configPath: '',
  startedAtMs: 0,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  logLimit: DEFAULT_LOG_LIMIT,
};

let characters = new Map();
const subscribers = new Set();

function nowMs() {
  return Date.now();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function portraitTypeForName(name) {
  let hash = 0;
  const text = `${name || ''}`;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % 3;
  if (idx === 0) return 'warrior';
  if (idx === 1) return 'mage';
  return 'gatherer';
}

function defaultCharacterState(name) {
  return {
    name,
    portraitType: portraitTypeForName(name),
    status: 'starting',
    lastUpdatedAtMs: 0,
    level: 0,
    hp: 0,
    maxHp: 0,
    xp: 0,
    maxXp: 0,
    position: { x: null, y: null, layer: null },
    routine: {
      name: null,
      phase: 'idle',
      priority: null,
      updatedAtMs: 0,
      error: '',
    },
    cooldown: {
      action: null,
      totalSeconds: 0,
      endsAtMs: 0,
    },
    task: {
      name: null,
      type: null,
      progress: 0,
      total: 0,
      label: 'No active task',
    },
    logLatest: 'No activity yet',
    logHistory: [],
  };
}

function cloneCharacterState(char, serverTimeMs) {
  const stale = char.lastUpdatedAtMs <= 0 || (serverTimeMs - char.lastUpdatedAtMs) > uiMeta.staleAfterMs;
  return {
    name: char.name,
    portraitType: char.portraitType,
    status: char.status,
    stale,
    lastUpdatedAtMs: char.lastUpdatedAtMs,
    level: char.level,
    hp: char.hp,
    maxHp: char.maxHp,
    xp: char.xp,
    maxXp: char.maxXp,
    position: { ...char.position },
    routine: { ...char.routine },
    cooldown: { ...char.cooldown },
    task: { ...char.task },
    logLatest: char.logLatest,
    logHistory: char.logHistory.map(entry => ({ ...entry })),
  };
}

function emitChange() {
  for (const cb of subscribers) {
    try {
      cb();
    } catch {
      // Ignore listener failures so state updates continue.
    }
  }
}

function ensureCharacter(name) {
  if (!name) return null;
  if (!characters.has(name)) {
    characters.set(name, defaultCharacterState(name));
  }
  return characters.get(name);
}

function taskLabel(name, progress, total) {
  if (!name) return 'No active task';
  const safeProgress = toNumber(progress, 0);
  const safeTotal = toNumber(total, 0);
  if (safeTotal > 0) return `${name} (${safeProgress}/${safeTotal})`;
  return `${name}`;
}

export function initializeUiState({ characterNames = [], configPath = '', startedAt = nowMs(), staleAfterMs = DEFAULT_STALE_AFTER_MS, logLimit = DEFAULT_LOG_LIMIT } = {}) {
  uiMeta = {
    configPath,
    startedAtMs: toNumber(startedAt, nowMs()),
    staleAfterMs: Math.max(1, toNumber(staleAfterMs, DEFAULT_STALE_AFTER_MS)),
    logLimit: Math.max(1, toNumber(logLimit, DEFAULT_LOG_LIMIT)),
  };

  characters = new Map();
  for (const rawName of characterNames) {
    const name = `${rawName || ''}`.trim();
    if (!name) continue;
    characters.set(name, defaultCharacterState(name));
  }

  emitChange();
}

export function recordCharacterSnapshot(name, charData = {}) {
  const char = ensureCharacter(name);
  if (!char) return;

  const progress = toNumber(charData.task_progress, 0);
  const total = toNumber(charData.task_total, 0);

  char.status = 'running';
  char.lastUpdatedAtMs = nowMs();
  char.level = toNumber(charData.level, char.level);
  char.hp = toNumber(charData.hp, 0);
  char.maxHp = toNumber(charData.max_hp, 0);
  char.xp = toNumber(charData.xp, 0);
  char.maxXp = toNumber(charData.max_xp, 0);
  char.position = {
    x: charData.x ?? null,
    y: charData.y ?? null,
    layer: charData.layer ?? null,
  };
  char.task = {
    name: charData.task || null,
    type: charData.task_type || null,
    progress,
    total,
    label: taskLabel(charData.task || null, progress, total),
  };

  // Successful refresh indicates the routine state is no longer errored.
  if (char.routine.phase === 'error') {
    char.routine.phase = 'idle';
    char.routine.error = '';
    char.routine.updatedAtMs = nowMs();
  }

  emitChange();
}

export function recordRoutineState(name, { routineName = null, phase = 'idle', priority = null, error = '' } = {}) {
  const char = ensureCharacter(name);
  if (!char) return;

  char.routine = {
    name: routineName,
    phase,
    priority: priority == null ? null : toNumber(priority, null),
    updatedAtMs: nowMs(),
    error: error || '',
  };

  if (phase === 'error') {
    char.status = 'error';
  } else if (char.status === 'error') {
    char.status = 'running';
  }

  emitChange();
}

export function recordCooldown(name, { action = null, totalSeconds = 0, remainingSeconds = null, observedAt = nowMs() } = {}) {
  const char = ensureCharacter(name);
  if (!char) return;

  const total = Math.max(0, toNumber(totalSeconds, 0));
  const remaining = remainingSeconds == null ? total : Math.max(0, toNumber(remainingSeconds, total));
  const observedMs = toNumber(observedAt, nowMs());
  const endsAtMs = remaining > 0 ? observedMs + Math.round(remaining * 1000) : observedMs;

  char.cooldown = {
    action: action || null,
    totalSeconds: total,
    endsAtMs,
  };

  emitChange();
}

export function recordLog(name, { level = 'info', line = '', at = nowMs() } = {}) {
  const char = ensureCharacter(name);
  if (!char) return;

  const entry = {
    atMs: toNumber(at, nowMs()),
    level,
    line: `${line || ''}`,
  };

  char.logLatest = entry.line || char.logLatest;
  char.logHistory.push(entry);

  if (char.logHistory.length > uiMeta.logLimit) {
    char.logHistory = char.logHistory.slice(char.logHistory.length - uiMeta.logLimit);
  }

  emitChange();
}

export function getUiSnapshot() {
  const serverTimeMs = nowMs();
  const list = [...characters.values()].map(char => cloneCharacterState(char, serverTimeMs));

  return {
    serverTimeMs,
    configPath: uiMeta.configPath,
    startedAtMs: uiMeta.startedAtMs,
    characters: list,
  };
}

export function subscribeUiEvents(listener) {
  if (typeof listener !== 'function') {
    throw new Error('subscribeUiEvents(listener) requires a function');
  }
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

// Test helpers.
export function _resetUiStateForTests() {
  uiMeta = {
    configPath: '',
    startedAtMs: 0,
    staleAfterMs: DEFAULT_STALE_AFTER_MS,
    logLimit: DEFAULT_LOG_LIMIT,
  };
  characters = new Map();
  subscribers.clear();
}
