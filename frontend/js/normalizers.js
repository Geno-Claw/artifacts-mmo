function normalizeCharacter(raw) {
  const name = safeText(raw?.name, 'Unknown');
  const status = safeText(raw?.status, 'starting');
  const stale = !!raw?.stale;
  const offline = stale || status !== 'running';

  const maxHp = Math.max(0, toNumber(raw?.maxHp, 0));
  const hp = Math.max(0, toNumber(raw?.hp, 0));
  const maxXp = Math.max(0, toNumber(raw?.maxXp, 0));
  const xp = Math.max(0, toNumber(raw?.xp, 0));

  const taskLabel = safeText(raw?.task?.label, offline ? 'OFFLINE' : 'No active task');
  const gameLogLatest = safeText(raw?.gameLogLatest, offline ? PLACEHOLDER_LOG : 'Waiting for activity...');
  const gameLogLatestType = raw?.gameLogLatestType || null;
  const gameLogLatestAtMs = Math.max(0, toNumber(raw?.gameLogLatestAtMs, 0));
  const gameLogLatestDetail = raw?.gameLogLatestDetail || null;
  const logLatest = safeText(raw?.logLatest, offline ? PLACEHOLDER_LOG : 'No activity yet');

  const cooldown = raw?.cooldown || {};
  const totalSeconds = Math.max(0, toNumber(cooldown.totalSeconds, 0));
  const endsAtMs = Math.max(0, toNumber(cooldown.endsAtMs, 0));

  return {
    name,
    portraitType: safeText(raw?.portraitType, hashPortraitType(name)),
    status,
    stale,
    offline,
    lastUpdatedAtMs: Math.max(0, toNumber(raw?.lastUpdatedAtMs, 0)),
    level: Math.max(0, toNumber(raw?.level, 0)),
    hp,
    maxHp,
    xp,
    maxXp,
    gold: Math.max(0, toNumber(raw?.gold, 0)),
    position: {
      x: raw?.position?.x ?? null,
      y: raw?.position?.y ?? null,
      layer: raw?.position?.layer ?? null,
    },
    taskLabel,
    gameLogLatest,
    gameLogLatestType,
    gameLogLatestAtMs,
    gameLogLatestDetail,
    logLatest,
    cooldown: {
      action: safeText(cooldown.action, ''),
      totalSeconds,
      endsAtMs,
    },
  };
}

function statPct(value, maxValue) {
  if (maxValue <= 0) return 0;
  return Math.max(0, Math.min(100, (value / maxValue) * 100));
}

function toKey(name) {
  return encodeURIComponent(name);
}

function normalizeOrderStatus(status) {
  const value = safeText(status, '').toLowerCase();
  if (value === 'fulfilled') return 'fulfilled';
  if (value === 'claimed') return 'claimed';
  return 'open';
}

function normalizeOrderFilter(value, fallback = 'all') {
  const normalized = safeText(value, '').toLowerCase();
  if (ORDER_FILTER_LABELS[normalized]) return normalized;
  return ORDER_FILTER_LABELS[fallback] ? fallback : 'all';
}

function normalizeOrderRow(raw) {
  const itemCode = safeText(raw?.itemCode, '');
  const sourceType = safeText(raw?.sourceType, '');
  const sourceCode = safeText(raw?.sourceCode, '');
  if (!itemCode || !sourceType || !sourceCode) return null;

  return {
    id: safeText(raw?.id, `${sourceType}:${sourceCode}:${itemCode}`),
    itemCode,
    sourceType,
    sourceCode,
    status: normalizeOrderStatus(raw?.status),
    remainingQty: Math.max(0, toNumber(raw?.remainingQty, 0)),
    requestedQty: Math.max(0, toNumber(raw?.requestedQty, 0)),
    claimer: safeText(raw?.claim?.charName, ''),
    createdAtMs: toNumber(raw?.createdAtMs, 0),
  };
}

function normalizeControlAction(value, fallback = '') {
  const normalized = safeText(value, '').toLowerCase();
  if (normalized === 'reload' || normalized === 'reload-config' || normalized === 'reload_config') {
    return 'reload';
  }
  if (normalized === 'restart' || normalized === 'restart-bot' || normalized === 'restart_bot') {
    return 'restart';
  }
  if (normalized === 'clear-order-board' || normalized === 'clear_order_board') {
    return 'clear-order-board';
  }
  if (normalized === 'clear-gear-state' || normalized === 'clear_gear_state') {
    return 'clear-gear-state';
  }
  return fallback;
}

function getControlActionLabel(action, fallback = '') {
  const normalized = normalizeControlAction(action, '');
  return CONTROL_ACTION_LABELS[normalized] || fallback;
}

function normalizeControlOperationState(value, fallback = 'idle') {
  const normalized = safeText(value, '').toLowerCase();
  if (
    normalized === 'pending'
    || normalized === 'inflight'
    || normalized === 'in_flight'
    || normalized === 'running'
    || normalized === 'busy'
  ) {
    return 'in-flight';
  }
  if (normalized === 'ok' || normalized === 'done' || normalized === 'completed') {
    return 'success';
  }
  if (normalized === 'failed' || normalized === 'fail' || normalized === 'error') {
    return 'failure';
  }
  if (CONTROL_OPERATION_STATE_VALUES.has(normalized)) {
    return normalized;
  }
  return CONTROL_OPERATION_STATE_VALUES.has(fallback) ? fallback : 'idle';
}

function normalizeControlStatusSnapshot(rawPayload) {
  const sourceRaw = extractApiData(rawPayload);
  const source = sourceRaw && typeof sourceRaw === 'object' ? sourceRaw : {};
  const operation = source.operation && typeof source.operation === 'object' ? source.operation : {};
  const sourceErrorText = typeof source.error === 'string' ? source.error : '';

  const lifecycle = safeText(
    source.lifecycle
      ?? source.lifecycleState
      ?? source.runtimeState
      ?? source.state
      ?? source.status,
    'unknown'
  ).toLowerCase();

  const operationAction = normalizeControlAction(
    operation.name ?? operation.type ?? source.currentOperation ?? source.operationName ?? source.operation,
    ''
  );

  const operationState = safeText(
    operation.state ?? source.operationState ?? source.lockState ?? source.lockStatus,
    ''
  ).toLowerCase();

  const inFlight = toBoolLike(
    operation.inFlight ?? source.inFlight ?? source.operationInFlight ?? source.locked ?? source.busy
  )
    || operationState === 'in-flight'
    || operationState === 'pending'
    || operationState === 'running'
    || operationState === 'busy'
    || !!operationAction
    || lifecycle === 'starting'
    || lifecycle === 'stopping';

  const updatedAtMs = Math.max(0, toNumber(
    source.updatedAtMs
      ?? source.lastUpdatedAtMs
      ?? source.fetchedAtMs
      ?? source.updatedAt
      ?? source.timestamp
      ?? source.serverTimeMs,
    0
  ));

  const detail = safeText(
    operation.detail
      ?? source.detail
      ?? source.message
      ?? source.summary
      ?? source.error?.detail
      ?? source.error?.message
      ?? source.lastError?.detail
      ?? source.lastError?.message
      ?? sourceErrorText,
    ''
  );

  return {
    lifecycle: lifecycle || 'unknown',
    inFlight,
    operationAction,
    updatedAtMs: updatedAtMs || Date.now(),
    detail,
  };
}

function normalizeSkills(rawSkills) {
  const rows = [];
  if (Array.isArray(rawSkills)) {
    rawSkills.forEach((item, idx) => {
      const code = safeText(item?.code, `skill-${idx + 1}`);
      rows.push({
        code,
        level: Math.max(0, toNumber(item?.level, 0)),
        xp: Math.max(0, toNumber(item?.xp, 0)),
        maxXp: Math.max(0, toNumber(item?.maxXp, 0)),
        pct: Math.max(0, Math.min(100, toNumber(item?.pct, statPct(toNumber(item?.xp, 0), toNumber(item?.maxXp, 0))))),
      });
    });
  } else if (rawSkills && typeof rawSkills === 'object') {
    Object.entries(rawSkills).forEach(([code, value]) => {
      const item = value && typeof value === 'object' ? value : { level: value };
      rows.push({
        code: safeText(item?.code, code),
        level: Math.max(0, toNumber(item?.level, 0)),
        xp: Math.max(0, toNumber(item?.xp, 0)),
        maxXp: Math.max(0, toNumber(item?.maxXp, 0)),
        pct: Math.max(0, Math.min(100, toNumber(item?.pct, statPct(toNumber(item?.xp, 0), toNumber(item?.maxXp, 0))))),
      });
    });
  }

  return rows
    .filter((item) => !!item.code)
    .sort((a, b) => b.level - a.level || b.xp - a.xp || a.code.localeCompare(b.code));
}

function normalizeInventory(rawInventory) {
  const rows = [];
  if (Array.isArray(rawInventory)) {
    rawInventory.forEach((item, idx) => {
      rows.push({
        code: safeText(item?.code, ''),
        quantity: Math.max(0, toNumber(item?.quantity, 0)),
        slotIndex: Number.isFinite(Number(item?.slotIndex)) ? Number(item.slotIndex) : idx,
      });
    });
  } else if (rawInventory && typeof rawInventory === 'object') {
    Object.entries(rawInventory).forEach(([key, value], idx) => {
      const item = value && typeof value === 'object' ? value : { code: key, quantity: value };
      rows.push({
        code: safeText(item?.code, Number.isFinite(Number(key)) ? '' : key),
        quantity: Math.max(0, toNumber(item?.quantity, 0)),
        slotIndex: Number.isFinite(Number(item?.slotIndex))
          ? Number(item.slotIndex)
          : (Number.isFinite(Number(key)) ? Number(key) : idx),
      });
    });
  }

  return rows
    .filter((item) => item.code && item.quantity > 0)
    .sort((a, b) => a.slotIndex - b.slotIndex || a.code.localeCompare(b.code));
}

function normalizeEquipment(rawEquipment) {
  const rows = [];
  if (Array.isArray(rawEquipment)) {
    rawEquipment.forEach((item, idx) => {
      rows.push({
        slot: safeText(item?.slot, `slot-${idx + 1}`),
        code: safeText(item?.code, 'empty'),
        quantity: Math.max(0, toNumber(item?.quantity, item?.code ? 1 : 0)),
      });
    });
  } else if (rawEquipment && typeof rawEquipment === 'object') {
    Object.entries(rawEquipment).forEach(([slot, value]) => {
      if (!value) {
        rows.push({ slot: safeText(slot, 'slot'), code: 'empty', quantity: 0 });
        return;
      }
      const item = value && typeof value === 'object' ? value : { code: value, quantity: 1 };
      rows.push({
        slot: safeText(item?.slot, slot),
        code: safeText(item?.code, 'empty'),
        quantity: Math.max(0, toNumber(item?.quantity, item?.code ? 1 : 0)),
      });
    });
  }

  return rows.sort((a, b) => a.slot.localeCompare(b.slot));
}

function normalizeLogHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .map((item) => {
      if (typeof item === 'string') {
        return { atMs: 0, level: 'info', line: item };
      }
      return {
        atMs: Math.max(0, toNumber(item?.atMs ?? item?.at ?? item?.ts, 0)),
        level: safeText(item?.level, 'info'),
        line: safeText(item?.line ?? item?.message, ''),
      };
    })
    .filter((entry) => !!entry.line)
    .sort((a, b) => b.atMs - a.atMs);
}

function setConfigResultBanner(tone, text) {
  const normalizedTone = safeText(tone, '').toLowerCase();
  const normalizedText = safeText(text, '');
  if (!normalizedText) {
    modalState.configResultBanner = null;
    return;
  }
  modalState.configResultBanner = {
    tone: normalizedTone === 'success' || normalizedTone === 'warning' || normalizedTone === 'error'
      ? normalizedTone
      : 'warning',
    text: normalizedText,
  };
}

function normalizeValidationPath(pathValue) {
  if (Array.isArray(pathValue)) {
    if (pathValue.length === 0) return '$';
    return pathValue.reduce((acc, part) => {
      if (typeof part === 'number') return `${acc}[${part}]`;
      const token = safeText(part, '');
      return token ? `${acc}.${token}` : acc;
    }, '$');
  }

  const text = safeText(pathValue, '');
  if (!text) return '$';
  if (text.startsWith('$')) return text;
  if (text.startsWith('/')) {
    const tokens = text
      .split('/')
      .filter(Boolean)
      .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (tokens.length === 0) return '$';
    return `$${tokens.map((token) => (/^\d+$/.test(token) ? `[${token}]` : `.${token}`)).join('')}`;
  }
  if (/^\d+$/.test(text)) return `$[${text}]`;
  if (text.startsWith('.')) return `$${text}`;
  return `$.${text}`;
}

function normalizeValidationErrors(rawPayload) {
  const source = extractApiData(rawPayload);
  let rows = [];

  if (Array.isArray(source)) {
    rows = source;
  } else if (source && typeof source === 'object') {
    if (Array.isArray(source.errors)) rows = source.errors;
    else if (Array.isArray(source.validationErrors)) rows = source.validationErrors;
    else if (Array.isArray(source.issues)) rows = source.issues;
    else if (source.error && typeof source.error === 'object' && Array.isArray(source.error.errors)) rows = source.error.errors;
  }

  return rows
    .map((entry) => {
      if (typeof entry === 'string') {
        return { path: '$', message: safeText(entry, 'Validation error') };
      }
      const row = entry && typeof entry === 'object' ? entry : {};
      const message = safeText(
        row.message ?? row.error ?? row.detail ?? row.reason ?? row.msg,
        ''
      );
      if (!message) return null;
      const path = normalizeValidationPath(
        row.path ?? row.instancePath ?? row.dataPath ?? row.pointer ?? row.field ?? row.location
      );
      return { path, message };
    })
    .filter((row) => !!row);
}

function normalizeConfigEnvelope(rawPayload, { requireJson = false } = {}) {
  const sourceRaw = extractApiData(rawPayload);
  if (typeof sourceRaw === 'string') {
    const rawJson = sourceRaw;
    if (requireJson && !safeText(rawJson, '')) {
      throw new Error('Config payload missing JSON content');
    }
    return {
      rawJson,
      ifMatchHash: '',
      configPath: '',
      updatedAtMs: 0,
    };
  }

  const source = sourceRaw && typeof sourceRaw === 'object' ? sourceRaw : {};
  const ifMatchHash = safeText(
    source.ifMatchHash ?? source.hash ?? source.etag ?? source.contentHash ?? source.matchHash,
    ''
  );
  const configPath = safeText(source.configPath ?? source.path ?? source.filePath ?? source.file, '');
  const updatedAtMs = Math.max(
    0,
    toNumber(source.updatedAtMs ?? source.updatedAt ?? source.savedAtMs ?? source.fetchedAtMs, 0)
  );

  let rawJson = '';
  const stringCandidates = [
    source.rawJson,
    source.rawConfig,
    source.configText,
    source.raw,
    source.text,
    source.content,
  ];
  for (const candidate of stringCandidates) {
    if (typeof candidate !== 'string') continue;
    if (safeText(candidate, '')) {
      rawJson = candidate;
      break;
    }
  }

  if (!safeText(rawJson, '')) {
    let configObject = null;
    if (source.config && typeof source.config === 'object') configObject = source.config;
    else if (source.value && typeof source.value === 'object') configObject = source.value;
    else if (source.json && typeof source.json === 'object') configObject = source.json;
    else if (source.contents && typeof source.contents === 'object') configObject = source.contents;
    else if (!Array.isArray(source)) {
      const metaKeys = new Set([
        'ifMatchHash',
        'hash',
        'etag',
        'contentHash',
        'matchHash',
        'configPath',
        'path',
        'filePath',
        'file',
        'updatedAtMs',
        'updatedAt',
        'savedAtMs',
        'fetchedAtMs',
        'ok',
        'error',
        'detail',
        'code',
        'errors',
        'validationErrors',
        'issues',
      ]);
      const hasConfigKeys = Object.keys(source).some((key) => !metaKeys.has(key));
      if (hasConfigKeys) configObject = source;
    }
    if (configObject) {
      try {
        rawJson = JSON.stringify(configObject, null, 2);
      } catch {
        rawJson = '';
      }
    }
  }

  if (requireJson && !safeText(rawJson, '')) {
    throw new Error('Config payload missing JSON content');
  }

  return {
    rawJson,
    ifMatchHash,
    configPath,
    updatedAtMs,
  };
}

function buildConfigRequestPayload(parsedConfig) {
  const payload = {
    config: parsedConfig,
    rawJson: `${modalState.configEditorText ?? ''}`,
  };
  const ifMatchHash = safeText(modalState.configIfMatchHash, '');
  if (ifMatchHash) {
    payload.ifMatchHash = ifMatchHash;
  }
  return payload;
}

function parseConfigEditorJson() {
  try {
    const value = JSON.parse(`${modalState.configEditorText ?? ''}`);
    return { ok: true, value };
  } catch (err) {
    modalState.configValidationErrors = [];
    setConfigResultBanner('error', `MALFORMED JSON - ${safeText(err?.message, 'Unable to parse config JSON')}`);
    return { ok: false, value: null };
  }
}

function normalizeAchievements(rawAchievements) {
  if (!Array.isArray(rawAchievements)) return [];

  return rawAchievements
    .map((entry, idx) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const code = safeText(row.code ?? row.id ?? row.name, `achievement-${idx + 1}`);
      const title = safeText(row.name ?? row.title ?? row.label, code);
      const description = safeText(row.description, '');
      const points = Math.max(0, toNumber(row.points, 0));

      let objectives = [];
      if (Array.isArray(row.objectives) && row.objectives.length > 0) {
        objectives = row.objectives.map(obj => {
          const objCurrent = Math.max(0, toNumber(obj.current ?? obj.progress ?? obj.value, 0));
          const objTotal = Math.max(0, toNumber(obj.total ?? obj.target, 0));
          const objPct = objTotal > 0 ? statPct(objCurrent, objTotal) : 0;
          return {
            type: safeText(obj.type, ''),
            target: safeText(obj.target, ''),
            current: objCurrent,
            total: objTotal,
            pct: objPct,
            completed: objTotal > 0 && objCurrent >= objTotal,
          };
        });
      } else {
        const progress = row.progress && typeof row.progress === 'object' ? row.progress : {};
        const flatCurrent = Math.max(0, toNumber(
          row.current ?? row.value ?? row.count ?? progress.current ?? progress.value, 0));
        const flatTotal = Math.max(0, toNumber(
          row.total ?? row.target ?? row.max ?? progress.total ?? progress.target ?? progress.max, 0));
        objectives = [{
          type: safeText(row.type, ''),
          target: safeText(row.target, ''),
          current: flatCurrent,
          total: flatTotal,
          pct: flatTotal > 0 ? statPct(flatCurrent, flatTotal) : 0,
          completed: flatTotal > 0 && flatCurrent >= flatTotal,
        }];
      }

      const rawRewards = row.rewards && typeof row.rewards === 'object' ? row.rewards : {};
      const rewards = {
        gold: Math.max(0, toNumber(rawRewards.gold, 0)),
        items: Array.isArray(rawRewards.items)
          ? rawRewards.items
              .map(ri => ({ code: safeText(ri?.code, ''), quantity: Math.max(0, toNumber(ri?.quantity, 0)) }))
              .filter(ri => ri.code)
          : [],
      };

      const completedObjectives = objectives.filter(o => o.completed).length;
      const totalObjectives = objectives.length;
      const isMultiObjective = totalObjectives > 1;

      let progressCurrent, progressTotal, pct;
      if (isMultiObjective) {
        progressCurrent = completedObjectives;
        progressTotal = totalObjectives;
        pct = totalObjectives > 0 ? statPct(completedObjectives, totalObjectives) : 0;
      } else {
        progressCurrent = objectives[0]?.current ?? 0;
        progressTotal = objectives[0]?.total ?? 0;
        pct = objectives[0]?.pct ?? 0;
      }

      const completed = toBoolLike(row.completed ?? row.isCompleted ?? row.done)
        || safeText(row.status, '').toLowerCase() === 'completed'
        || (totalObjectives > 0 && completedObjectives === totalObjectives)
        || (progressTotal > 0 && progressCurrent >= progressTotal);

      return {
        code,
        title,
        description,
        points,
        objectives,
        rewards,
        completed,
        isMultiObjective,
        progressCurrent,
        progressTotal,
        pct,
        searchText: `${code} ${title} ${description}`.toLowerCase(),
      };
    })
    .sort((a, b) => Number(b.completed) - Number(a.completed) || b.pct - a.pct || a.code.localeCompare(b.code));
}

function normalizeAchievementSummary(rawSummary, achievementRows) {
  const source = rawSummary && typeof rawSummary === 'object'
    ? (rawSummary.summary && typeof rawSummary.summary === 'object' ? rawSummary.summary : rawSummary)
    : {};

  const derivedCompleted = achievementRows.filter((row) => row.completed).length;
  const derivedTotal = achievementRows.length;
  let total = Math.max(
    0,
    toNumber(
      source.total ?? source.totalCount ?? source.totalAvailable ?? source.available ?? source.achievementsTotal,
      derivedTotal
    )
  );
  let completed = Math.max(
    0,
    toNumber(source.completed ?? source.completedCount ?? source.totalCompleted ?? source.done, derivedCompleted)
  );

  if (total === 0 && derivedTotal > 0) total = derivedTotal;
  if (completed > total && total > 0) completed = total;

  const totalPoints = achievementRows
    .filter(r => r.completed)
    .reduce((sum, r) => sum + (r.points || 0), 0);

  return {
    account: safeText(source.account ?? source.username ?? source.accountName ?? source.name, ''),
    completed,
    total,
    totalPoints,
  };
}

function getAchievementTypeFilterValue() {
  return ACHIEVEMENT_TYPE_FILTER_LABELS[modalState.achievementTypeFilter] ? modalState.achievementTypeFilter : 'all';
}

function getAchievementFilterValue() {
  return ACHIEVEMENT_FILTER_LABELS[modalState.achievementFilter] ? modalState.achievementFilter : 'all';
}

function getAchievementState(row) {
  if (row.completed) return 'completed';
  if (row.progressCurrent > 0 || row.pct > 0) return 'in-progress';
  return 'not-started';
}

function getAchievementProgressText(row) {
  if (row.isMultiObjective) {
    const done = row.objectives.filter(o => o.completed).length;
    return `${done} / ${row.objectives.length} objectives`;
  }
  if (row.progressTotal > 0) {
    const pct = row.completed ? 100 : Math.max(0, Math.min(100, Math.round(row.pct)));
    return `${formatNumberish(row.progressCurrent, '0')} / ${formatNumberish(row.progressTotal, '0')} (${pct}%)`;
  }
  if (row.progressCurrent > 0) {
    return formatNumberish(row.progressCurrent, '0');
  }
  return '--';
}

function filterAchievements(rows) {
  const filter = getAchievementFilterValue();
  const typeFilter = getAchievementTypeFilterValue();
  const typeSet = ACHIEVEMENT_TYPE_FILTER_MAP[typeFilter];
  const needle = `${modalState.achievementSearch ?? ''}`.trim().toLowerCase();

  return rows.filter((row) => {
    const state = getAchievementState(row);
    if (filter === 'completed' && state !== 'completed') return false;
    if (filter === 'in-progress' && state !== 'in-progress') return false;
    if (filter === 'not-started' && state !== 'not-started') return false;
    if (typeSet && !row.objectives.some(o => typeSet.includes(o.type))) return false;
    if (needle && !row.searchText.includes(needle)) return false;
    return true;
  });
}
