/**
 * Live dashboard UI state.
 * Keeps a fixed roster from BOT_CONFIG and emits change notifications.
 */

const DEFAULT_STALE_AFTER_MS = 120_000;
const MAX_LOG_HISTORY = 50;
const DEFAULT_LOG_LIMIT = 20;
const KNOWN_SKILL_CODES = Object.freeze([
  'mining',
  'woodcutting',
  'fishing',
  'cooking',
  'weaponcrafting',
  'gearcrafting',
  'jewelrycrafting',
  'alchemy',
]);
const EQUIPMENT_SLOTS = Object.freeze([
  'helmet',
  'body_armor',
  'leg_armor',
  'boots',
  'weapon',
  'shield',
  'ring1',
  'ring2',
  'amulet',
  'artifact1',
  'artifact2',
  'artifact3',
  'utility1',
  'utility2',
  'bag',
  'rune',
]);

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

function toTrimmedStringOrNull(value) {
  if (value == null) return null;
  const text = `${value}`.trim();
  return text || null;
}

function pctOf(xp, maxXp) {
  if (maxXp <= 0) return 0;
  const pct = (xp / maxXp) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

function orderedSkillCodes(charData = {}) {
  const codes = new Set(KNOWN_SKILL_CODES);
  for (const key of Object.keys(charData)) {
    if (!key.endsWith('_level')) continue;
    const code = key.slice(0, -'_level'.length);
    if (!code) continue;
    if (
      Object.prototype.hasOwnProperty.call(charData, `${code}_xp`) ||
      Object.prototype.hasOwnProperty.call(charData, `${code}_max_xp`) ||
      KNOWN_SKILL_CODES.includes(code)
    ) {
      codes.add(code);
    }
  }

  return [...codes].sort((a, b) => {
    const aKnown = KNOWN_SKILL_CODES.indexOf(a);
    const bKnown = KNOWN_SKILL_CODES.indexOf(b);
    if (aKnown >= 0 && bKnown >= 0) return aKnown - bKnown;
    if (aKnown >= 0) return -1;
    if (bKnown >= 0) return 1;
    return a.localeCompare(b);
  });
}

function normalizeSkills(charData = {}) {
  return orderedSkillCodes(charData).map((code) => {
    const level = Math.max(0, toNumber(charData[`${code}_level`], 0));
    const xp = Math.max(0, toNumber(charData[`${code}_xp`], 0));
    const maxXp = Math.max(0, toNumber(charData[`${code}_max_xp`], 0));
    return {
      code,
      level,
      xp,
      maxXp,
      pct: pctOf(xp, maxXp),
    };
  });
}

function normalizeInventory(charData = {}) {
  if (!Array.isArray(charData.inventory)) return [];
  const result = [];
  for (let i = 0; i < charData.inventory.length; i++) {
    const rawSlot = charData.inventory[i] || {};
    const code = toTrimmedStringOrNull(rawSlot.code);
    if (!code) continue;

    const quantity = Math.max(0, toNumber(rawSlot.quantity, 0));
    if (quantity <= 0) continue;

    const slotNumber = Number(rawSlot.slot);
    const slotIndex = Number.isFinite(slotNumber) ? Math.max(0, Math.floor(slotNumber)) : i;
    result.push({ code, quantity, slotIndex });
  }
  return result;
}

function normalizeEquipment(charData = {}) {
  const result = [];
  for (const slot of EQUIPMENT_SLOTS) {
    const code = toTrimmedStringOrNull(charData[`${slot}_slot`]);
    if (!code) continue;

    const quantity = Math.max(1, toNumber(charData[`${slot}_slot_quantity`], 1));
    result.push({ slot, code, quantity });
  }
  return result;
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
    gold: 0,
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
    detailLogHistory: [],
    gameLogLatest: 'Waiting for activity...',
    gameLogLatestType: null,
    gameLogLatestAtMs: 0,
    gameLogLatestDetail: null,
    gameLogHistory: [],
    skills: [],
    inventory: [],
    equipment: [],
  };
}

function isCharacterStale(char, serverTimeMs = nowMs()) {
  // Never updated → stale
  if (char.lastUpdatedAtMs <= 0) return true;

  // If cooldown is still active (not yet expired), character is busy — not stale
  if (char.cooldown.endsAtMs > serverTimeMs) return false;

  // Cooldown expired (READY): stale only if no updates for staleAfterMs since cooldown ended
  const idleSinceMs = Math.max(char.lastUpdatedAtMs, char.cooldown.endsAtMs);
  return (serverTimeMs - idleSinceMs) > uiMeta.staleAfterMs;
}

function cloneCharacterState(char, serverTimeMs) {
  const stale = isCharacterStale(char, serverTimeMs);
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
    gameLogLatest: char.gameLogLatest,
    gameLogLatestType: char.gameLogLatestType,
    gameLogLatestAtMs: char.gameLogLatestAtMs,
    gameLogLatestDetail: char.gameLogLatestDetail,
    gameLogHistory: char.gameLogHistory.map(entry => ({ ...entry })),
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
  char.gold = toNumber(charData.gold, 0);
  char.position = {
    x: charData.x ?? null,
    y: charData.y ?? null,
    layer: charData.layer ?? null,
  };
  char.skills = normalizeSkills(charData);
  char.inventory = normalizeInventory(charData);
  char.equipment = normalizeEquipment(charData);
  char.task = {
    name: charData.task || null,
    type: charData.task_type || null,
    progress,
    total,
    label: taskLabel(charData.task || null, progress, total),
  };

  // Extract cooldown from character data (API returns cooldown_expiration on GET /characters/{name}).
  // Only overwrite if the API-reported cooldown is in the future and later than what we already have,
  // so we don't clobber a more precise endsAtMs from a recent recordCooldown() action response.
  const rawExpiration = charData.cooldown_expiration;
  if (rawExpiration) {
    const expirationMs = new Date(rawExpiration).getTime();
    if (Number.isFinite(expirationMs) && expirationMs > nowMs() && expirationMs > char.cooldown.endsAtMs) {
      const totalFromApi = Math.max(0, toNumber(charData.cooldown, 0));
      char.cooldown = {
        action: char.cooldown.action,
        totalSeconds: totalFromApi || Math.ceil((expirationMs - nowMs()) / 1000),
        endsAtMs: expirationMs,
      };
    }
  }

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
  char.detailLogHistory.push(entry);

  if (char.logHistory.length > uiMeta.logLimit) {
    char.logHistory = char.logHistory.slice(char.logHistory.length - uiMeta.logLimit);
  }
  if (char.detailLogHistory.length > MAX_LOG_HISTORY) {
    char.detailLogHistory = char.detailLogHistory.slice(char.detailLogHistory.length - MAX_LOG_HISTORY);
  }

  emitChange();
}

export function recordGameLog(name, { line = '', type = null, at = nowMs(), detail = null } = {}) {
  const char = ensureCharacter(name);
  if (!char) return;

  const entry = {
    atMs: toNumber(at, nowMs()),
    type,
    line: `${line || ''}`,
    detail,
  };

  char.gameLogLatest = entry.line || char.gameLogLatest;
  char.gameLogLatestType = type;
  char.gameLogLatestAtMs = entry.atMs;
  char.gameLogLatestDetail = detail;
  char.gameLogHistory.push(entry);

  if (char.gameLogHistory.length > uiMeta.logLimit) {
    char.gameLogHistory = char.gameLogHistory.slice(char.gameLogHistory.length - uiMeta.logLimit);
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

export function getUiCharacterDetail(name) {
  const charName = `${name || ''}`.trim();
  if (!charName) return null;
  const char = characters.get(charName);
  if (!char) return null;

  return {
    identity: {
      name: char.name,
      status: char.status,
      stale: isCharacterStale(char),
      level: char.level,
    },
    skills: char.skills.map(skill => ({ ...skill })),
    inventory: char.inventory.map(item => ({ ...item })),
    equipment: char.equipment.map(item => ({ ...item })),
    stats: {
      hp: char.hp,
      maxHp: char.maxHp,
      xp: char.xp,
      maxXp: char.maxXp,
      gold: char.gold,
      position: { ...char.position },
      task: { ...char.task },
    },
    logHistory: char.detailLogHistory.map(entry => ({ ...entry })),
    updatedAtMs: char.lastUpdatedAtMs,
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
