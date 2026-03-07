const CONFIG_EDITOR_FALLBACK_ROUTINES = Object.freeze([
  {
    type: 'rest',
    label: 'Rest',
    toggleable: false,
    readOnly: false,
    defaultConfig: { type: 'rest', priority: 100, triggerPct: 40, targetPct: 80 },
  },
  {
    type: 'depositBank',
    label: 'Deposit Bank',
    toggleable: false,
    readOnly: false,
    defaultConfig: {
      type: 'depositBank',
      priority: 50,
      threshold: 0.8,
      sellOnGE: true,
      recycleEquipment: true,
      depositGold: true,
    },
  },
  {
    type: 'bankExpansion',
    label: 'Bank Expansion',
    toggleable: false,
    readOnly: false,
    defaultConfig: {
      type: 'bankExpansion',
      priority: 45,
      checkIntervalMs: 300000,
      maxGoldPct: 0.7,
      goldBuffer: 0,
    },
  },
  {
    type: 'event',
    label: 'Events',
    toggleable: true,
    readOnly: false,
    defaultConfig: {
      type: 'event',
      priority: 90,
      enabled: false,
      monsterEvents: true,
      resourceEvents: true,
      npcEvents: false,
      minTimeRemainingMs: 120000,
      maxMonsterType: 'elite',
      cooldownMs: 60000,
      minWinrate: 80,
    },
  },
  {
    type: 'completeTask',
    label: 'Complete Task',
    toggleable: false,
    readOnly: true,
    defaultConfig: { type: 'completeTask', priority: 45 },
  },
  {
    type: 'orderFulfillment',
    label: 'Order Fulfillment',
    toggleable: true,
    readOnly: false,
    defaultConfig: {
      type: 'orderFulfillment',
      priority: 8,
      enabled: false,
      maxLosses: 2,
      craftScanLimit: 1,
      orderBoard: {
        enabled: true,
        createOrders: true,
        fulfillOrders: true,
        leaseMs: 120000,
        blockedRetryMs: 600000,
      },
    },
  },
  {
    type: 'skillRotation',
    label: 'Skill Rotation',
    toggleable: true,
    readOnly: false,
    defaultConfig: {
      type: 'skillRotation',
      enabled: false,
      priority: 5,
      maxLosses: 2,
      weights: {},
      goals: {
        mining: 20,
        woodcutting: 20,
        fishing: 20,
        cooking: 5,
        alchemy: 5,
        weaponcrafting: 2,
        gearcrafting: 2,
        jewelrycrafting: 2,
        combat: 10,
        npc_task: 1,
      },
      craftBlacklist: {},
      taskCollection: {},
      achievementTypes: ['combat_kill', 'gathering', 'combat_drop', 'crafting', 'task'],
      achievementBlacklist: [],
      orderBoard: {
        enabled: false,
        createOrders: false,
        fulfillOrders: false,
        leaseMs: 120000,
        blockedRetryMs: 600000,
      },
    },
  },
]);

const CONFIG_EDITOR_ROOT_TABS = new Set(['global', 'characters', 'raw']);
const CONFIG_EDITOR_CHARACTER_TABS = new Set(['settings', 'routines', 'skillRotation']);
const CONFIG_EDITOR_COMBAT_MONSTER_TYPES = Object.freeze(['normal', 'elite', 'boss']);
const CONFIG_EDITOR_EVENT_MONSTER_TYPES = Object.freeze(['normal', 'elite']);
const CONFIG_EDITOR_RAW_ONLY_SKILL_FIELDS = Object.freeze(['achievementBlacklist', 'craftBlacklist', 'taskCollection']);
const CONFIG_EDITOR_FALLBACK_SKILLS = Object.freeze([
  'mining',
  'woodcutting',
  'fishing',
  'cooking',
  'alchemy',
  'weaponcrafting',
  'gearcrafting',
  'jewelrycrafting',
  'combat',
  'npc_task',
  'item_task',
  'achievement',
]);
const CONFIG_EDITOR_FALLBACK_ACHIEVEMENT_TYPES = Object.freeze([
  'combat_kill',
  'gathering',
  'crafting',
  'combat_drop',
  'use',
  'recycling',
  'task',
  'npc_buy',
  'npc_sell',
]);

function isConfigEditorObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfigEditorJson(value) {
  return structuredClone(value);
}

function stringifyConfigEditorDraft(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseConfigEditorRawText(rawText) {
  try {
    return {
      ok: true,
      value: JSON.parse(`${rawText ?? ''}`),
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      error: safeText(err?.message, 'Unable to parse config JSON'),
    };
  }
}

function getConfigEditorOptions() {
  return isConfigEditorObject(modalState.configOptions) ? modalState.configOptions : {};
}

function getConfigEditorRoutineMetadata() {
  const routines = getConfigEditorOptions().routines;
  return Array.isArray(routines) && routines.length > 0 ? routines : CONFIG_EDITOR_FALLBACK_ROUTINES;
}

function getConfigEditorRoutineMeta(type) {
  return getConfigEditorRoutineMetadata().find((entry) => entry?.type === type)
    || CONFIG_EDITOR_FALLBACK_ROUTINES.find((entry) => entry.type === type)
    || null;
}

function buildDefaultRoutineConfig(type) {
  const meta = getConfigEditorRoutineMeta(type);
  if (meta?.defaultConfig && isConfigEditorObject(meta.defaultConfig)) {
    return cloneConfigEditorJson(meta.defaultConfig);
  }
  return { type };
}

function getConfigEditorSkillNames() {
  const options = getConfigEditorOptions();
  return Array.isArray(options.skillNames) && options.skillNames.length > 0
    ? options.skillNames
    : [...CONFIG_EDITOR_FALLBACK_SKILLS];
}

function getConfigEditorAchievementTypes() {
  const options = getConfigEditorOptions();
  return Array.isArray(options.achievementTypes) && options.achievementTypes.length > 0
    ? options.achievementTypes
    : [...CONFIG_EDITOR_FALLBACK_ACHIEVEMENT_TYPES];
}

function syncConfigEditorTextFromDraft() {
  if (!isConfigEditorObject(modalState.configDraft)) return;
  modalState.configEditorText = stringifyConfigEditorDraft(modalState.configDraft);
  modalState.configRawParseError = '';
}

function commitConfigEditorDraft(nextDraft, { clearBanner = true } = {}) {
  modalState.configDraft = nextDraft;
  syncConfigEditorTextFromDraft();
  modalState.configValidationErrors = [];
  if (clearBanner) {
    setConfigResultBanner('', '');
  }
}

function applyConfigEditorMutation(mutator, { clearBanner = true } = {}) {
  if (!isConfigEditorObject(modalState.configDraft)) return false;
  const nextDraft = cloneConfigEditorJson(modalState.configDraft);
  const changed = mutator(nextDraft);
  if (changed === false) return false;
  commitConfigEditorDraft(nextDraft, { clearBanner });
  renderModalContent();
  return true;
}

function maybeCommitConfigEditorRawText() {
  const parsed = parseConfigEditorRawText(modalState.configEditorText);
  if (!parsed.ok) {
    modalState.configRawParseError = parsed.error;
    return parsed;
  }

  modalState.configDraft = parsed.value;
  modalState.configRawParseError = '';
  modalState.configValidationErrors = [];
  setConfigResultBanner('', '');
  return parsed;
}

function ensureConfigEditorCanLeaveRaw() {
  if (modalState.configView !== 'raw') return true;
  const parsed = parseConfigEditorRawText(modalState.configEditorText);
  if (parsed.ok) {
    modalState.configDraft = parsed.value;
    modalState.configRawParseError = '';
    return true;
  }

  modalState.configRawParseError = parsed.error;
  modalState.configValidationErrors = [{ path: '$', message: parsed.error }];
  setConfigResultBanner('error', `MALFORMED JSON - ${parsed.error}`);
  renderModalContent();
  return false;
}

function getConfigEditorCharacters(draft = modalState.configDraft) {
  return Array.isArray(draft?.characters) ? draft.characters.filter(isConfigEditorObject) : [];
}

function getConfigEditorCharacterNames(draft = modalState.configDraft) {
  return getConfigEditorCharacters(draft)
    .map(character => safeText(character?.name, ''))
    .filter(Boolean);
}

function getConfigEditorActiveCharacterName() {
  const names = getConfigEditorCharacterNames();
  if (names.length === 0) return '';
  const preferred = safeText(modalState.configFocusedCharacter, '');
  if (preferred && names.includes(preferred)) return preferred;
  modalState.configFocusedCharacter = names[0];
  return names[0];
}

function findConfigEditorCharacter(name, draft = modalState.configDraft) {
  return getConfigEditorCharacters(draft).find((character) => safeText(character?.name, '') === name) || null;
}

function findConfigEditorRoutine(characterConfig, type) {
  const routines = Array.isArray(characterConfig?.routines) ? characterConfig.routines : [];
  return routines.find((routine) => safeText(routine?.type, '') === type) || null;
}

function ensureConfigEditorCharacterNode(draft, name) {
  if (!Array.isArray(draft.characters)) draft.characters = [];
  const existing = draft.characters.find((character) => safeText(character?.name, '') === name);
  if (existing) return existing;
  return null;
}

function ensureConfigEditorRoutineNode(draft, characterName, type) {
  const character = ensureConfigEditorCharacterNode(draft, characterName);
  if (!character) return null;
  if (!Array.isArray(character.routines)) character.routines = [];
  const existing = character.routines.find((routine) => safeText(routine?.type, '') === type);
  if (existing) return existing;
  const created = buildDefaultRoutineConfig(type);
  character.routines.push(created);
  return created;
}

function ensureConfigEditorSettingsNode(draft, characterName) {
  const character = ensureConfigEditorCharacterNode(draft, characterName);
  if (!character) return null;
  if (!isConfigEditorObject(character.settings)) character.settings = {};
  return character.settings;
}

function getConfigEditorPathValue(source, path, fallback = '') {
  const segments = `${path ?? ''}`.split('.').filter(Boolean);
  let node = source;
  for (const segment of segments) {
    if (!isConfigEditorObject(node) || !(segment in node)) return fallback;
    node = node[segment];
  }
  return node === undefined ? fallback : node;
}

function setConfigEditorPathValue(target, path, value) {
  const segments = `${path ?? ''}`.split('.').filter(Boolean);
  if (segments.length === 0) return false;

  let node = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (!isConfigEditorObject(node[segment])) {
      node[segment] = {};
    }
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
  return true;
}

function configEditorNumberValue(element, fallback = 0) {
  const raw = Number(element?.value);
  if (!Number.isFinite(raw)) return fallback;
  return raw;
}

function getConfigEditorDescription(path) {
  const descriptions = getConfigEditorOptions().descriptions;
  if (!isConfigEditorObject(descriptions)) return '';
  return safeText(descriptions[path], '');
}

function renderConfigInfoIcon(description) {
  const text = safeText(description, '');
  if (!text) return '';
  return `<span class="config-info-chip" tabindex="0" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">i</span>`;
}

function renderConfigFieldLabelMarkup(label, description = '') {
  return `
    <span class="config-field-label-text">${escapeHtml(label)}</span>
    ${renderConfigInfoIcon(description)}
  `;
}

function renderConfigSectionTitle(title, description = '') {
  return `<h3 class="modal-section-title config-heading-line">${escapeHtml(title)}${renderConfigInfoIcon(description)}</h3>`;
}

function renderConfigSubsectionLabel(label, description = '') {
  return `<div class="config-subsection-label">${renderConfigFieldLabelMarkup(label, description)}</div>`;
}

function configEditorCheckboxTag(label, checked, dataset = '', description = '') {
  return `
    <label class="config-check-row">
      <input type="checkbox" class="config-check-input" ${checked ? 'checked' : ''} ${dataset}>
      <span class="config-inline-label">${renderConfigFieldLabelMarkup(label, description)}</span>
    </label>
  `;
}

function renderConfigEditorMeta(detail) {
  const configPath = safeText(detail?.configPath, '--');
  const hash = safeText(modalState.configIfMatchHash, '--');
  const updatedAt = formatTime(detail?.updatedAtMs);

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Active Config</h3>
      <div class="config-editor-meta">
        <article class="modal-stat">
          <div class="modal-stat-label">Path</div>
          <div class="modal-stat-value">${escapeHtml(configPath)}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">If-Match Hash</div>
          <div class="modal-stat-value">${escapeHtml(hash)}</div>
        </article>
      </div>
      <div class="achievement-result-count">Loaded ${escapeHtml(updatedAt)}</div>
    </section>
  `;
}

function renderConfigEditorTabs() {
  const tabs = [
    ['global', 'Global'],
    ['characters', 'Characters'],
    ['raw', 'Raw'],
  ];

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Editor</h3>
      <div class="config-tab-row">
        ${tabs.map(([value, label]) => `
          <button
            type="button"
            class="config-tab-btn${modalState.configView === value ? ' is-active' : ''}"
            data-config-root-tab="${escapeHtml(value)}"
          >${escapeHtml(label.toUpperCase())}</button>
        `).join('')}
      </div>
      <div class="config-editor-help">
        Structured editing covers the main runtime fields. Use Raw for priorities, roster changes, unsupported routines, and advanced skill rotation collections.
      </div>
    </section>
  `;
}

function renderConfigEditorValidation() {
  const validationErrors = Array.isArray(modalState.configValidationErrors)
    ? modalState.configValidationErrors
    : [];
  const parseError = safeText(modalState.configRawParseError, '');

  if (validationErrors.length === 0 && !parseError) return '';

  const rows = validationErrors.slice();
  if (parseError) {
    rows.unshift({ path: '$', message: parseError });
  }

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Validation Errors</h3>
      <div class="config-validation-list">
        ${rows.map((row) => `
          <div class="config-validation-item">
            <span class="config-validation-path">${escapeHtml(safeText(row.path, '$'))}</span>
            <span class="config-validation-message">${escapeHtml(safeText(row.message, 'Validation error'))}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderConfigEditorRestartState() {
  if (!modalState.configRequiresRestart) return '';
  const reasons = Array.isArray(modalState.configRestartReasons) ? modalState.configRestartReasons : [];

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Restart Required</h3>
      <div class="config-restart-panel">
        <div class="config-editor-help">Config was saved, but some changes only apply after a bot restart.</div>
        ${reasons.length > 0 ? `
          <div class="config-restart-list">
            ${reasons.map((reason) => `<div class="config-restart-item">${escapeHtml(reason)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    </section>
  `;
}

function renderConfigEditorActions() {
  const busy = modalState.configBusy;
  const busyAttr = busy ? ' disabled' : '';

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Actions</h3>
      <div class="config-editor-actions">
        <button type="button" class="config-editor-btn" data-config-action="validate"${busyAttr}>VALIDATE</button>
        <button type="button" class="config-editor-btn" data-config-action="save"${busyAttr}>SAVE</button>
      </div>
    </section>
  `;
}

function renderGlobalEventsSection(draft) {
  const resources = Array.isArray(getConfigEditorOptions().resources) ? getConfigEditorOptions().resources : [];
  const selected = new Set(
    Array.isArray(draft?.events?.gatherResources)
      ? draft.events.gatherResources.map((value) => safeText(value, '')).filter(Boolean)
      : []
  );

  return `
    <section class="modal-section">
      ${renderConfigSectionTitle('Events', getConfigEditorDescription('events'))}
      <div class="config-editor-help">Select the resource event codes this account should gather. Leave empty to allow all resource events.</div>
      <label class="config-field-block">
        <span class="config-field-label">${renderConfigFieldLabelMarkup('Gather Resources', getConfigEditorDescription('events.gatherResources'))}</span>
        <select class="config-select config-multi-select" data-config-scope="global-gather-resources" multiple size="${Math.min(10, Math.max(4, resources.length || 4))}">
          ${resources.map((resource) => `
            <option value="${escapeHtml(resource.code)}"${selected.has(resource.code) ? ' selected' : ''}>
              ${escapeHtml(resource.code)}${resource.skill ? ` · ${escapeHtml(resource.skill)}` : ''}${resource.level ? ` · LV ${escapeHtml(formatNumberish(resource.level, '0'))}` : ''}
            </option>
          `).join('')}
        </select>
      </label>
    </section>
  `;
}

function configEditorNpcCodes(draft) {
  const optionCodes = (Array.isArray(getConfigEditorOptions().npcEvents) ? getConfigEditorOptions().npcEvents : [])
    .map((entry) => safeText(entry?.code, ''))
    .filter(Boolean);
  const draftCodes = Object.keys(isConfigEditorObject(draft?.npcBuyList) ? draft.npcBuyList : {});
  return ['_any']
    .concat([...new Set(optionCodes.concat(draftCodes).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    .filter((code, index, list) => list.indexOf(code) === index);
}

function getConfigEditorNpcOptionsMap() {
  const map = new Map();
  const npcEvents = Array.isArray(getConfigEditorOptions().npcEvents) ? getConfigEditorOptions().npcEvents : [];
  for (const npcEvent of npcEvents) {
    const code = safeText(npcEvent?.code, '');
    if (!code) continue;
    map.set(code, Array.isArray(npcEvent?.buyableItems) ? npcEvent.buyableItems : []);
  }

  const anyItems = [];
  const seen = new Set();
  for (const items of map.values()) {
    for (const item of items) {
      const code = safeText(item?.code, '');
      if (!code || seen.has(code)) continue;
      seen.add(code);
      anyItems.push(item);
    }
  }
  anyItems.sort((a, b) => `${a?.code ?? ''}`.localeCompare(`${b?.code ?? ''}`));
  map.set('_any', anyItems);
  return map;
}

function renderNpcBuySection(draft) {
  const npcBuyList = isConfigEditorObject(draft?.npcBuyList) ? draft.npcBuyList : {};
  const npcOptionsMap = getConfigEditorNpcOptionsMap();
  const npcCodes = configEditorNpcCodes(draft);

  return `
    <section class="modal-section">
      ${renderConfigSectionTitle('NPC Buy List', getConfigEditorDescription('npcBuyList'))}
      <div class="config-editor-help">Configure event-merchant purchases by NPC. The special <code>_any</code> group applies to all NPC events.</div>
      <div class="config-npc-groups">
        ${npcCodes.map((npcCode) => {
          const rows = Array.isArray(npcBuyList[npcCode]) ? npcBuyList[npcCode] : [];
          const options = npcOptionsMap.get(npcCode) || [];
          const seen = new Set(options.map((item) => safeText(item?.code, '')));
          const mergedOptions = options.slice();
          for (const row of rows) {
            const code = safeText(row?.code, '');
            if (!code || seen.has(code)) continue;
            seen.add(code);
            mergedOptions.push({ code, name: code, level: 0, type: '' });
          }
          mergedOptions.sort((a, b) => `${a?.code ?? ''}`.localeCompare(`${b?.code ?? ''}`));

          return `
            <article class="config-npc-group">
              <div class="config-card-header">
                <div>
                  <div class="config-card-title">${escapeHtml(npcCode === '_any' ? 'All NPC Events (_any)' : npcCode)}</div>
                  <div class="config-card-meta">${escapeHtml(rows.length > 0 ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : 'No items configured')}</div>
                </div>
                <button type="button" class="config-mini-btn" data-config-scope="npc-buy-add-row" data-config-npc="${escapeHtml(npcCode)}">ADD ROW</button>
              </div>
              ${rows.length === 0 ? '<div class="config-editor-help">No NPC purchases configured.</div>' : ''}
              ${rows.map((row, index) => `
                <div class="config-inline-grid">
                  <label class="config-field-block">
                    <span class="config-field-label">${renderConfigFieldLabelMarkup('Item', getConfigEditorDescription('npcBuyList[].code'))}</span>
                    <select
                      class="config-select"
                      data-config-scope="npc-buy-item"
                      data-config-npc="${escapeHtml(npcCode)}"
                      data-config-index="${index}"
                    >
                      ${mergedOptions.map((item) => `
                        <option value="${escapeHtml(item.code)}"${safeText(row?.code, '') === item.code ? ' selected' : ''}>
                          ${escapeHtml(item.code)}${item.name && item.name !== item.code ? ` · ${escapeHtml(item.name)}` : ''}
                        </option>
                      `).join('')}
                    </select>
                  </label>
                  <label class="config-field-block">
                    <span class="config-field-label">${renderConfigFieldLabelMarkup('Max Total', getConfigEditorDescription('npcBuyList[].maxTotal'))}</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      class="sandbox-input"
                      value="${escapeHtml(formatNumberish(row?.maxTotal, '1').replace(/,/g, ''))}"
                      data-config-scope="npc-buy-max-total"
                      data-config-npc="${escapeHtml(npcCode)}"
                      data-config-index="${index}"
                    >
                  </label>
                  <div class="config-inline-actions">
                    <button type="button" class="config-mini-btn config-danger-btn" data-config-scope="npc-buy-remove-row" data-config-npc="${escapeHtml(npcCode)}" data-config-index="${index}">REMOVE</button>
                  </div>
                </div>
              `).join('')}
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderConfigGlobalView(draft) {
  return `
    ${renderGlobalEventsSection(draft)}
    ${renderNpcBuySection(draft)}
  `;
}

function renderCharacterTabNav(activeCharacterName) {
  const names = getConfigEditorCharacterNames();
  const characterTab = CONFIG_EDITOR_CHARACTER_TABS.has(modalState.configCharacterTab)
    ? modalState.configCharacterTab
    : 'settings';

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Characters</h3>
      <div class="config-character-row">
        ${names.map((name) => `
          <button
            type="button"
            class="config-tab-btn${name === activeCharacterName ? ' is-active' : ''}"
            data-config-select-character="${escapeHtml(name)}"
          >${escapeHtml(name)}</button>
        `).join('')}
      </div>
      <div class="config-tab-row">
        ${[
          ['settings', 'Settings'],
          ['routines', 'Routines'],
          ['skillRotation', 'Skill Rotation'],
        ].map(([value, label]) => `
          <button
            type="button"
            class="config-tab-btn${characterTab === value ? ' is-active' : ''}"
            data-config-character-tab="${escapeHtml(value)}"
          >${escapeHtml(label.toUpperCase())}</button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderConfigCharacterIdentity(character) {
  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Identity</h3>
      <div class="modal-grid">
        <article class="modal-stat">
          <div class="modal-stat-label">Name</div>
          <div class="modal-stat-value">${escapeHtml(safeText(character?.name, '--'))}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Skin</div>
          <div class="modal-stat-value">${escapeHtml(safeText(character?.skin, '--'))}</div>
        </article>
      </div>
      <div class="config-editor-help">Identity and roster edits remain raw-only in v1.</div>
    </section>
  `;
}

function renderConfigSettingField(label, attrs, value, type = 'number', extra = '', description = '') {
  if (type === 'checkbox') {
    return configEditorCheckboxTag(label, value === true, attrs, description);
  }

  return `
    <label class="config-field-block">
      <span class="config-field-label">${renderConfigFieldLabelMarkup(label, description)}</span>
      <input type="${escapeHtml(type)}" class="sandbox-input" value="${escapeHtml(`${value ?? ''}`)}" ${attrs} ${extra}>
    </label>
  `;
}

function renderConfigSettingsView(character) {
  const name = safeText(character?.name, '');
  const settings = isConfigEditorObject(character?.settings) ? character.settings : {};
  const potions = isConfigEditorObject(settings.potions) ? settings.potions : {};
  const combat = isConfigEditorObject(potions.combat) ? potions.combat : {};
  const bankTravel = isConfigEditorObject(potions.bankTravel) ? potions.bankTravel : {};
  const settingDesc = (path) => getConfigEditorDescription(`characters[].settings.${path}`);

  return `
    ${renderConfigCharacterIdentity(character)}
    <section class="modal-section">
      ${renderConfigSectionTitle('Potion Automation')}
      <div class="config-field-grid">
        ${renderConfigSettingField(
          'Potions Enabled',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.enabled"`,
          potions.enabled === true,
          'checkbox',
          '',
          settingDesc('potions.enabled'),
        )}
        ${renderConfigSettingField(
          'Combat Potions',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.combat.enabled"`,
          combat.enabled === true,
          'checkbox',
          '',
          settingDesc('potions.combat.enabled'),
        )}
        ${renderConfigSettingField(
          'Refill Below',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.combat.refillBelow"`,
          getConfigEditorPathValue(potions, 'combat.refillBelow', 2),
          'number',
          'min="0" step="1"',
          settingDesc('potions.combat.refillBelow'),
        )}
        ${renderConfigSettingField(
          'Target Quantity',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.combat.targetQuantity"`,
          getConfigEditorPathValue(potions, 'combat.targetQuantity', 5),
          'number',
          'min="1" step="1"',
          settingDesc('potions.combat.targetQuantity'),
        )}
        ${renderConfigSettingField(
          'Poison Bias',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.combat.poisonBias"`,
          combat.poisonBias !== false,
          'checkbox',
          '',
          settingDesc('potions.combat.poisonBias'),
        )}
        ${renderConfigSettingField(
          'Respect Utility',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.combat.respectNonPotionUtility"`,
          combat.respectNonPotionUtility !== false,
          'checkbox',
          '',
          settingDesc('potions.combat.respectNonPotionUtility'),
        )}
      </div>
      ${renderConfigSubsectionLabel('Combat Monster Types', settingDesc('potions.combat.monsterTypes'))}
      <div class="config-check-grid">
        ${CONFIG_EDITOR_COMBAT_MONSTER_TYPES.map((monsterType) => configEditorCheckboxTag(
          `Use On ${formatUpperToken(monsterType, monsterType)}`,
          Array.isArray(combat.monsterTypes) ? combat.monsterTypes.includes(monsterType) : false,
          `data-config-scope="setting-combat-monster-type" data-config-character="${escapeHtml(name)}" data-config-value="${escapeHtml(monsterType)}"`,
          settingDesc('potions.combat.monsterTypes'),
        )).join('')}
      </div>
    </section>
    <section class="modal-section">
      ${renderConfigSectionTitle('Bank Travel Potions')}
      <div class="config-field-grid">
        ${renderConfigSettingField(
          'Travel Potions',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.enabled"`,
          bankTravel.enabled === true,
          'checkbox',
          '',
          settingDesc('potions.bankTravel.enabled'),
        )}
        ${renderConfigSettingField(
          'Allow Recall',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.allowRecall"`,
          bankTravel.allowRecall !== false,
          'checkbox',
          '',
          settingDesc('potions.bankTravel.allowRecall'),
        )}
        ${renderConfigSettingField(
          'Allow Forest Bank',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.allowForestBank"`,
          bankTravel.allowForestBank !== false,
          'checkbox',
          '',
          settingDesc('potions.bankTravel.allowForestBank'),
        )}
        ${renderConfigSettingField(
          'Min Savings Seconds',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.minSavingsSeconds"`,
          getConfigEditorPathValue(potions, 'bankTravel.minSavingsSeconds', 60),
          'number',
          'min="0" step="1"',
          settingDesc('potions.bankTravel.minSavingsSeconds'),
        )}
        ${renderConfigSettingField(
          'Return To Origin',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.includeReturnToOrigin"`,
          bankTravel.includeReturnToOrigin !== false,
          'checkbox',
          '',
          settingDesc('potions.bankTravel.includeReturnToOrigin'),
        )}
        ${renderConfigSettingField(
          'Move Seconds Per Tile',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.moveSecondsPerTile"`,
          getConfigEditorPathValue(potions, 'bankTravel.moveSecondsPerTile', 5),
          'number',
          'min="0" step="1"',
          settingDesc('potions.bankTravel.moveSecondsPerTile'),
        )}
        ${renderConfigSettingField(
          'Item Use Seconds',
          `data-config-scope="setting-field" data-config-character="${escapeHtml(name)}" data-config-field="potions.bankTravel.itemUseSeconds"`,
          getConfigEditorPathValue(potions, 'bankTravel.itemUseSeconds', 3),
          'number',
          'min="0" step="1"',
          settingDesc('potions.bankTravel.itemUseSeconds'),
        )}
      </div>
      <div class="config-editor-help">Travel mode stays fixed to <code>smart</code> in the structured editor. ${escapeHtml(getConfigEditorDescription('characters[].settings.potions.bankTravel.mode'))}</div>
    </section>
  `;
}

function renderConfigRoutineCard(character, routineMeta) {
  const routine = findConfigEditorRoutine(character, routineMeta.type);
  const routineConfig = routine || routineMeta.defaultConfig || { type: routineMeta.type };
  const name = safeText(character?.name, '');
  const missing = !routine;
  const priority = getConfigEditorPathValue(routineConfig, 'priority', '--');
  const missingLabel = missing ? 'Missing - will materialize on save' : 'Configured';
  const routineDesc = (path) => getConfigEditorDescription(`characters[].routines.${routineMeta.type}.${path}`);

  const fieldAttrs = (path) => `data-config-scope="routine-field" data-config-character="${escapeHtml(name)}" data-config-routine="${escapeHtml(routineMeta.type)}" data-config-field="${escapeHtml(path)}"`;

  let body = '';
  if (routineMeta.type === 'rest') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Trigger %', fieldAttrs('triggerPct'), getConfigEditorPathValue(routineConfig, 'triggerPct', 40), 'number', 'min="0" step="1"', routineDesc('triggerPct'))}
        ${renderConfigSettingField('Target %', fieldAttrs('targetPct'), getConfigEditorPathValue(routineConfig, 'targetPct', 80), 'number', 'min="0" step="1"', routineDesc('targetPct'))}
      </div>
    `;
  } else if (routineMeta.type === 'depositBank') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Threshold', fieldAttrs('threshold'), getConfigEditorPathValue(routineConfig, 'threshold', 0.8), 'number', 'min="0" max="1" step="0.05"', routineDesc('threshold'))}
        ${renderConfigSettingField('Sell On GE', fieldAttrs('sellOnGE'), getConfigEditorPathValue(routineConfig, 'sellOnGE', true) === true, 'checkbox', '', routineDesc('sellOnGE'))}
        ${renderConfigSettingField('Recycle Equipment', fieldAttrs('recycleEquipment'), getConfigEditorPathValue(routineConfig, 'recycleEquipment', true) === true, 'checkbox', '', routineDesc('recycleEquipment'))}
        ${renderConfigSettingField('Deposit Gold', fieldAttrs('depositGold'), getConfigEditorPathValue(routineConfig, 'depositGold', true) === true, 'checkbox', '', routineDesc('depositGold'))}
      </div>
    `;
  } else if (routineMeta.type === 'bankExpansion') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Check Interval Ms', fieldAttrs('checkIntervalMs'), getConfigEditorPathValue(routineConfig, 'checkIntervalMs', 300000), 'number', 'min="10000" step="1000"', routineDesc('checkIntervalMs'))}
        ${renderConfigSettingField('Max Gold %', fieldAttrs('maxGoldPct'), getConfigEditorPathValue(routineConfig, 'maxGoldPct', 0.7), 'number', 'min="0" max="1" step="0.05"', routineDesc('maxGoldPct'))}
        ${renderConfigSettingField('Gold Buffer', fieldAttrs('goldBuffer'), getConfigEditorPathValue(routineConfig, 'goldBuffer', 0), 'number', 'min="0" step="1"', routineDesc('goldBuffer'))}
      </div>
    `;
  } else if (routineMeta.type === 'event') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Enabled', fieldAttrs('enabled'), getConfigEditorPathValue(routineConfig, 'enabled', false) === true, 'checkbox', '', routineDesc('enabled'))}
        ${renderConfigSettingField('Monster Events', fieldAttrs('monsterEvents'), getConfigEditorPathValue(routineConfig, 'monsterEvents', true) === true, 'checkbox', '', routineDesc('monsterEvents'))}
        ${renderConfigSettingField('Resource Events', fieldAttrs('resourceEvents'), getConfigEditorPathValue(routineConfig, 'resourceEvents', true) === true, 'checkbox', '', routineDesc('resourceEvents'))}
        ${renderConfigSettingField('NPC Events', fieldAttrs('npcEvents'), getConfigEditorPathValue(routineConfig, 'npcEvents', false) === true, 'checkbox', '', routineDesc('npcEvents'))}
        ${renderConfigSettingField('Min Time Remaining Ms', fieldAttrs('minTimeRemainingMs'), getConfigEditorPathValue(routineConfig, 'minTimeRemainingMs', 120000), 'number', 'min="10000" step="1000"', routineDesc('minTimeRemainingMs'))}
        <label class="config-field-block">
          <span class="config-field-label">${renderConfigFieldLabelMarkup('Max Monster Type', routineDesc('maxMonsterType'))}</span>
          <select class="config-select" ${fieldAttrs('maxMonsterType')}>
            ${CONFIG_EDITOR_EVENT_MONSTER_TYPES.map((value) => `
              <option value="${escapeHtml(value)}"${getConfigEditorPathValue(routineConfig, 'maxMonsterType', 'elite') === value ? ' selected' : ''}>${escapeHtml(formatUpperToken(value, value))}</option>
            `).join('')}
          </select>
        </label>
        ${renderConfigSettingField('Cooldown Ms', fieldAttrs('cooldownMs'), getConfigEditorPathValue(routineConfig, 'cooldownMs', 60000), 'number', 'min="0" step="1000"', routineDesc('cooldownMs'))}
        ${renderConfigSettingField('Min Winrate', fieldAttrs('minWinrate'), getConfigEditorPathValue(routineConfig, 'minWinrate', 80), 'number', 'min="0" max="100" step="1"', routineDesc('minWinrate'))}
      </div>
    `;
  } else if (routineMeta.type === 'completeTask') {
    body = `
      <div class="config-editor-help">This routine stays always-on in the structured editor. Priority remains raw-only.</div>
    `;
  } else if (routineMeta.type === 'orderFulfillment') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Enabled', fieldAttrs('enabled'), getConfigEditorPathValue(routineConfig, 'enabled', false) === true, 'checkbox', '', routineDesc('enabled'))}
        ${renderConfigSettingField('Max Losses', fieldAttrs('maxLosses'), getConfigEditorPathValue(routineConfig, 'maxLosses', 2), 'number', 'min="0" step="1"', routineDesc('maxLosses'))}
        ${renderConfigSettingField('Craft Scan Limit', fieldAttrs('craftScanLimit'), getConfigEditorPathValue(routineConfig, 'craftScanLimit', 1), 'number', 'min="1" step="1"', routineDesc('craftScanLimit'))}
        ${renderConfigSettingField('Board Enabled', fieldAttrs('orderBoard.enabled'), getConfigEditorPathValue(routineConfig, 'orderBoard.enabled', true) === true, 'checkbox', '', routineDesc('orderBoard.enabled'))}
        ${renderConfigSettingField('Create Orders', fieldAttrs('orderBoard.createOrders'), getConfigEditorPathValue(routineConfig, 'orderBoard.createOrders', true) === true, 'checkbox', '', routineDesc('orderBoard.createOrders'))}
        ${renderConfigSettingField('Fulfill Orders', fieldAttrs('orderBoard.fulfillOrders'), getConfigEditorPathValue(routineConfig, 'orderBoard.fulfillOrders', true) === true, 'checkbox', '', routineDesc('orderBoard.fulfillOrders'))}
        ${renderConfigSettingField('Lease Ms', fieldAttrs('orderBoard.leaseMs'), getConfigEditorPathValue(routineConfig, 'orderBoard.leaseMs', 120000), 'number', 'min="1000" step="1000"', routineDesc('orderBoard.leaseMs'))}
        ${renderConfigSettingField('Blocked Retry Ms', fieldAttrs('orderBoard.blockedRetryMs'), getConfigEditorPathValue(routineConfig, 'orderBoard.blockedRetryMs', 600000), 'number', 'min="1000" step="1000"', routineDesc('orderBoard.blockedRetryMs'))}
      </div>
    `;
  } else if (routineMeta.type === 'skillRotation') {
    body = `
      <div class="config-field-grid">
        ${renderConfigSettingField('Enabled', fieldAttrs('enabled'), getConfigEditorPathValue(routineConfig, 'enabled', false) === true, 'checkbox', '', routineDesc('enabled'))}
      </div>
      <div class="config-inline-actions">
        <button type="button" class="config-mini-btn" data-config-open-skill-tab="${escapeHtml(name)}">OPEN SKILL ROTATION TAB</button>
      </div>
    `;
  }

  return `
    <article class="config-routine-card${missing ? ' is-missing' : ''}">
      <div class="config-card-header">
        <div>
          <div class="config-card-title">${escapeHtml(routineMeta.label || routineMeta.type)}</div>
          <div class="config-card-meta">${escapeHtml(missingLabel)}</div>
        </div>
        <div class="config-card-priority">PRIORITY ${escapeHtml(formatNumberish(priority, '--'))}${renderConfigInfoIcon(routineDesc('priority'))}</div>
      </div>
      ${body}
    </article>
  `;
}

function renderConfigRoutinesView(character) {
  const routines = getConfigEditorRoutineMetadata();

  return `
    ${renderConfigCharacterIdentity(character)}
    <section class="modal-section">
      <h3 class="modal-section-title">Managed Routines</h3>
      <div class="config-editor-help">Priority is shown for reference but remains raw-only. Missing routines stay placeholders until save or explicit edits.</div>
      <div class="config-routine-grid">
        ${routines.map((routineMeta) => renderConfigRoutineCard(character, routineMeta)).join('')}
      </div>
    </section>
  `;
}

function renderConfigSkillRotationView(character) {
  const name = safeText(character?.name, '');
  const routine = findConfigEditorRoutine(character, 'skillRotation');
  const routineConfig = routine || buildDefaultRoutineConfig('skillRotation');
  const skillNames = getConfigEditorSkillNames();
  const achievementTypes = getConfigEditorAchievementTypes();
  const weights = isConfigEditorObject(routineConfig.weights) ? routineConfig.weights : {};
  const goals = isConfigEditorObject(routineConfig.goals) ? routineConfig.goals : {};
  const activeAchievementTypes = new Set(Array.isArray(routineConfig.achievementTypes) ? routineConfig.achievementTypes : []);
  const fieldAttrs = (path) => `data-config-scope="skill-rotation-field" data-config-character="${escapeHtml(name)}" data-config-field="${escapeHtml(path)}"`;
  const skillDesc = (path) => getConfigEditorDescription(`characters[].routines.skillRotation.${path}`);

  const rawOnlyActive = CONFIG_EDITOR_RAW_ONLY_SKILL_FIELDS.filter((field) => {
    const value = routineConfig[field];
    if (Array.isArray(value)) return value.length > 0;
    if (isConfigEditorObject(value)) return Object.keys(value).length > 0;
    return false;
  });

  return `
    ${renderConfigCharacterIdentity(character)}
    <section class="modal-section">
      ${renderConfigSectionTitle('Skill Rotation')}
      <div class="config-field-grid">
        ${renderConfigSettingField('Enabled', fieldAttrs('enabled'), getConfigEditorPathValue(routineConfig, 'enabled', false) === true, 'checkbox', '', skillDesc('enabled'))}
        ${renderConfigSettingField('Max Losses', fieldAttrs('maxLosses'), getConfigEditorPathValue(routineConfig, 'maxLosses', 2), 'number', 'min="0" step="1"', skillDesc('maxLosses'))}
        ${renderConfigSettingField('Board Enabled', fieldAttrs('orderBoard.enabled'), getConfigEditorPathValue(routineConfig, 'orderBoard.enabled', false) === true, 'checkbox', '', skillDesc('orderBoard.enabled'))}
        ${renderConfigSettingField('Create Orders', fieldAttrs('orderBoard.createOrders'), getConfigEditorPathValue(routineConfig, 'orderBoard.createOrders', false) === true, 'checkbox', '', skillDesc('orderBoard.createOrders'))}
        ${renderConfigSettingField('Fulfill Orders', fieldAttrs('orderBoard.fulfillOrders'), getConfigEditorPathValue(routineConfig, 'orderBoard.fulfillOrders', false) === true, 'checkbox', '', skillDesc('orderBoard.fulfillOrders'))}
        ${renderConfigSettingField('Lease Ms', fieldAttrs('orderBoard.leaseMs'), getConfigEditorPathValue(routineConfig, 'orderBoard.leaseMs', 120000), 'number', 'min="1000" step="1000"', skillDesc('orderBoard.leaseMs'))}
        ${renderConfigSettingField('Blocked Retry Ms', fieldAttrs('orderBoard.blockedRetryMs'), getConfigEditorPathValue(routineConfig, 'orderBoard.blockedRetryMs', 600000), 'number', 'min="1000" step="1000"', skillDesc('orderBoard.blockedRetryMs'))}
      </div>
    </section>
    <section class="modal-section">
      ${renderConfigSectionTitle('Skill Weights', skillDesc('weights'))}
      <div class="config-skill-grid">
        ${skillNames.map((skill) => `
          <label class="config-field-block">
            <span class="config-field-label">${escapeHtml(skill)}</span>
            <input
              type="number"
              min="0"
              step="1"
              class="sandbox-input"
              value="${escapeHtml(`${weights[skill] ?? 0}`)}"
              data-config-scope="skill-weight"
              data-config-character="${escapeHtml(name)}"
              data-config-skill="${escapeHtml(skill)}"
            >
          </label>
        `).join('')}
      </div>
    </section>
    <section class="modal-section">
      ${renderConfigSectionTitle('Goal Targets', skillDesc('goals'))}
      <div class="config-skill-grid">
        ${skillNames.map((skill) => `
          <label class="config-field-block">
            <span class="config-field-label">${escapeHtml(skill)}</span>
            <input
              type="number"
              min="1"
              step="1"
              class="sandbox-input"
              value="${escapeHtml(`${goals[skill] ?? ''}`)}"
              data-config-scope="skill-goal"
              data-config-character="${escapeHtml(name)}"
              data-config-skill="${escapeHtml(skill)}"
            >
          </label>
        `).join('')}
      </div>
    </section>
    <section class="modal-section">
      ${renderConfigSectionTitle('Achievement Types', skillDesc('achievementTypes'))}
      <div class="config-check-grid">
        ${achievementTypes.map((type) => configEditorCheckboxTag(
          type,
          activeAchievementTypes.has(type),
          `data-config-scope="skill-achievement-type" data-config-character="${escapeHtml(name)}" data-config-value="${escapeHtml(type)}"`,
          skillDesc('achievementTypes'),
        )).join('')}
      </div>
      <div class="config-editor-help">
        Advanced collections stay raw-only: ${escapeHtml(CONFIG_EDITOR_RAW_ONLY_SKILL_FIELDS.join(', '))}.
        ${rawOnlyActive.length > 0 ? ` Current raw-only data: ${escapeHtml(rawOnlyActive.join(', '))}.` : ''}
      </div>
    </section>
  `;
}

function renderConfigRawView() {
  const busy = modalState.configBusy;
  const busyAttr = busy ? ' disabled' : '';

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Raw JSON</h3>
      <div class="config-editor-help">Fallback editor for any field or structure not yet covered by the structured UI.</div>
      <textarea
        class="config-editor-textarea"
        data-config-json
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        aria-label="Raw config JSON editor"${busyAttr}
      >${escapeHtml(`${modalState.configEditorText ?? ''}`)}</textarea>
    </section>
  `;
}

function renderConfigCharactersView(draft) {
  const names = getConfigEditorCharacterNames(draft);
  if (names.length === 0) {
    return `
      <section class="modal-section">
        <h3 class="modal-section-title">Characters</h3>
        <div class="modal-empty">No characters are configured.</div>
      </section>
    `;
  }

  const activeCharacterName = getConfigEditorActiveCharacterName();
  const activeCharacter = findConfigEditorCharacter(activeCharacterName, draft);
  if (!activeCharacter) {
    return `
      <section class="modal-section">
        <h3 class="modal-section-title">Characters</h3>
        <div class="modal-empty">Selected character could not be resolved.</div>
      </section>
    `;
  }

  let content = '';
  if (modalState.configCharacterTab === 'routines') {
    content = renderConfigRoutinesView(activeCharacter);
  } else if (modalState.configCharacterTab === 'skillRotation') {
    content = renderConfigSkillRotationView(activeCharacter);
  } else {
    content = renderConfigSettingsView(activeCharacter);
  }

  return `
    ${renderCharacterTabNav(activeCharacterName)}
    ${content}
  `;
}

function renderStructuredConfigModal(detail) {
  const draft = isConfigEditorObject(modalState.configDraft) ? modalState.configDraft : null;
  if (!draft) {
    return `
      <div class="config-editor">
        ${renderConfigEditorMeta(detail)}
        <div class="modal-empty">Config draft is unavailable.</div>
        ${renderConfigEditorActions()}
      </div>
    `;
  }

  let content = '';
  if (modalState.configView === 'characters') {
    content = renderConfigCharactersView(draft);
  } else if (modalState.configView === 'raw') {
    content = renderConfigRawView();
  } else {
    content = renderConfigGlobalView(draft);
  }

  return `
    <div class="config-editor structured-config-editor">
      ${renderConfigEditorMeta(detail)}
      ${renderConfigEditorTabs()}
      ${content}
      ${renderConfigEditorRestartState()}
      ${renderConfigEditorValidation()}
      ${renderConfigEditorActions()}
    </div>
  `;
}

function selectConfigEditorRootTab(nextView) {
  if (!CONFIG_EDITOR_ROOT_TABS.has(nextView)) return false;
  if (modalState.configView === nextView) return false;
  if (!ensureConfigEditorCanLeaveRaw()) return false;
  modalState.configView = nextView;
  renderModalContent();
  return true;
}

function selectConfigEditorCharacter(name) {
  if (!name) return false;
  if (!ensureConfigEditorCanLeaveRaw()) return false;
  modalState.configView = 'characters';
  modalState.configFocusedCharacter = name;
  renderModalContent();
  return true;
}

function selectConfigEditorCharacterTab(nextTab) {
  if (!CONFIG_EDITOR_CHARACTER_TABS.has(nextTab)) return false;
  if (!ensureConfigEditorCanLeaveRaw()) return false;
  modalState.configView = 'characters';
  modalState.configCharacterTab = nextTab;
  renderModalContent();
  return true;
}

function handleConfigSettingField(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const path = safeText(element?.dataset?.configField, '');
  if (!characterName || !path) return false;

  return applyConfigEditorMutation((draft) => {
    const settings = ensureConfigEditorSettingsNode(draft, characterName);
    if (!settings) return false;

    const value = element.type === 'checkbox' ? element.checked : configEditorNumberValue(element, getConfigEditorPathValue(settings, path, 0));
    return setConfigEditorPathValue(settings, path, value);
  });
}

function handleConfigCombatMonsterType(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const value = safeText(element?.dataset?.configValue, '');
  if (!characterName || !value) return false;

  return applyConfigEditorMutation((draft) => {
    const settings = ensureConfigEditorSettingsNode(draft, characterName);
    if (!settings) return false;
    if (!isConfigEditorObject(settings.potions)) settings.potions = {};
    if (!isConfigEditorObject(settings.potions.combat)) settings.potions.combat = {};
    const current = Array.isArray(settings.potions.combat.monsterTypes)
      ? settings.potions.combat.monsterTypes.filter(Boolean)
      : [];
    const next = current.filter((entry) => entry !== value);
    if (element.checked) next.push(value);
    settings.potions.combat.monsterTypes = [...new Set(next)];
    return true;
  });
}

function handleConfigRoutineField(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const routineType = safeText(element?.dataset?.configRoutine, '');
  const path = safeText(element?.dataset?.configField, '');
  if (!characterName || !routineType || !path) return false;

  return applyConfigEditorMutation((draft) => {
    const routine = ensureConfigEditorRoutineNode(draft, characterName, routineType);
    if (!routine) return false;
    const currentValue = getConfigEditorPathValue(routine, path, 0);
    const value = element.tagName === 'SELECT'
      ? safeText(element.value, currentValue)
      : (element.type === 'checkbox' ? element.checked : configEditorNumberValue(element, currentValue));
    return setConfigEditorPathValue(routine, path, value);
  });
}

function handleConfigSkillRotationField(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const path = safeText(element?.dataset?.configField, '');
  if (!characterName || !path) return false;

  return applyConfigEditorMutation((draft) => {
    const routine = ensureConfigEditorRoutineNode(draft, characterName, 'skillRotation');
    if (!routine) return false;
    const currentValue = getConfigEditorPathValue(routine, path, 0);
    const value = element.type === 'checkbox' ? element.checked : configEditorNumberValue(element, currentValue);
    return setConfigEditorPathValue(routine, path, value);
  });
}

function handleConfigSkillWeight(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const skill = safeText(element?.dataset?.configSkill, '');
  if (!characterName || !skill) return false;

  return applyConfigEditorMutation((draft) => {
    const routine = ensureConfigEditorRoutineNode(draft, characterName, 'skillRotation');
    if (!routine) return false;
    if (!isConfigEditorObject(routine.weights)) routine.weights = {};
    routine.weights[skill] = configEditorNumberValue(element, 0);
    return true;
  });
}

function handleConfigSkillGoal(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const skill = safeText(element?.dataset?.configSkill, '');
  if (!characterName || !skill) return false;

  return applyConfigEditorMutation((draft) => {
    const routine = ensureConfigEditorRoutineNode(draft, characterName, 'skillRotation');
    if (!routine) return false;
    if (!isConfigEditorObject(routine.goals)) routine.goals = {};
    routine.goals[skill] = Math.max(1, configEditorNumberValue(element, 1));
    return true;
  });
}

function handleConfigSkillAchievementType(element) {
  const characterName = safeText(element?.dataset?.configCharacter, '');
  const value = safeText(element?.dataset?.configValue, '');
  if (!characterName || !value) return false;

  return applyConfigEditorMutation((draft) => {
    const routine = ensureConfigEditorRoutineNode(draft, characterName, 'skillRotation');
    if (!routine) return false;
    const current = Array.isArray(routine.achievementTypes) ? routine.achievementTypes.filter(Boolean) : [];
    const next = current.filter((entry) => entry !== value);
    if (element.checked) next.push(value);
    routine.achievementTypes = [...new Set(next)];
    return true;
  });
}

function handleConfigGlobalGatherResources(element) {
  return applyConfigEditorMutation((draft) => {
    if (!isConfigEditorObject(draft.events)) draft.events = {};
    draft.events.gatherResources = [...element.selectedOptions]
      .map((option) => safeText(option?.value, ''))
      .filter(Boolean);
    return true;
  });
}

function handleConfigNpcRowChange(element, updater) {
  const npcCode = safeText(element?.dataset?.configNpc, '');
  const index = Number(element?.dataset?.configIndex);
  if (!npcCode || !Number.isInteger(index) || index < 0) return false;

  return applyConfigEditorMutation((draft) => {
    if (!isConfigEditorObject(draft.npcBuyList)) draft.npcBuyList = {};
    if (!Array.isArray(draft.npcBuyList[npcCode])) draft.npcBuyList[npcCode] = [];
    const rows = draft.npcBuyList[npcCode];
    if (!isConfigEditorObject(rows[index])) {
      rows[index] = { code: '', maxTotal: 1 };
    }
    updater(rows[index], rows, draft);
    return true;
  });
}

function handleConfigModalClick(event) {
  const rootTabBtn = closestFromEventTarget(event, 'button[data-config-root-tab]');
  if (rootTabBtn && modalRefs.content.contains(rootTabBtn)) {
    return selectConfigEditorRootTab(safeText(rootTabBtn.dataset.configRootTab, ''));
  }

  const characterBtn = closestFromEventTarget(event, 'button[data-config-select-character]');
  if (characterBtn && modalRefs.content.contains(characterBtn)) {
    return selectConfigEditorCharacter(safeText(characterBtn.dataset.configSelectCharacter, ''));
  }

  const characterTabBtn = closestFromEventTarget(event, 'button[data-config-character-tab]');
  if (characterTabBtn && modalRefs.content.contains(characterTabBtn)) {
    return selectConfigEditorCharacterTab(safeText(characterTabBtn.dataset.configCharacterTab, ''));
  }

  const openSkillTabBtn = closestFromEventTarget(event, 'button[data-config-open-skill-tab]');
  if (openSkillTabBtn && modalRefs.content.contains(openSkillTabBtn)) {
    const characterName = safeText(openSkillTabBtn.dataset.configOpenSkillTab, '');
    if (!characterName) return false;
    modalState.configFocusedCharacter = characterName;
    modalState.configView = 'characters';
    modalState.configCharacterTab = 'skillRotation';
    renderModalContent();
    return true;
  }

  const npcAddBtn = closestFromEventTarget(event, 'button[data-config-scope="npc-buy-add-row"]');
  if (npcAddBtn && modalRefs.content.contains(npcAddBtn)) {
    const npcCode = safeText(npcAddBtn.dataset.configNpc, '');
    if (!npcCode) return false;
    return applyConfigEditorMutation((draft) => {
      if (!isConfigEditorObject(draft.npcBuyList)) draft.npcBuyList = {};
      if (!Array.isArray(draft.npcBuyList[npcCode])) draft.npcBuyList[npcCode] = [];
      const options = getConfigEditorNpcOptionsMap().get(npcCode) || [];
      const code = safeText(options[0]?.code, '');
      draft.npcBuyList[npcCode].push({
        code,
        maxTotal: 1,
      });
      return true;
    });
  }

  const npcRemoveBtn = closestFromEventTarget(event, 'button[data-config-scope="npc-buy-remove-row"]');
  if (npcRemoveBtn && modalRefs.content.contains(npcRemoveBtn)) {
    const npcCode = safeText(npcRemoveBtn.dataset.configNpc, '');
    const index = Number(npcRemoveBtn.dataset.configIndex);
    if (!npcCode || !Number.isInteger(index) || index < 0) return false;
    return applyConfigEditorMutation((draft) => {
      if (!isConfigEditorObject(draft.npcBuyList) || !Array.isArray(draft.npcBuyList[npcCode])) return false;
      draft.npcBuyList[npcCode].splice(index, 1);
      return true;
    });
  }

  return false;
}

function handleConfigModalInput(event) {
  if (!modalRefs.content) return false;

  const rawEditor = closestFromEventTarget(event, 'textarea[data-config-json]');
  if (rawEditor && modalRefs.content.contains(rawEditor)) {
    modalState.configEditorText = `${rawEditor.value ?? ''}`;
    maybeCommitConfigEditorRawText();
    return true;
  }

  if (event.type !== 'change') {
    return false;
  }

  const globalResources = closestFromEventTarget(event, 'select[data-config-scope="global-gather-resources"]');
  if (globalResources && modalRefs.content.contains(globalResources)) {
    return handleConfigGlobalGatherResources(globalResources);
  }

  const settingField = closestFromEventTarget(event, '[data-config-scope="setting-field"]');
  if (settingField && modalRefs.content.contains(settingField)) {
    return handleConfigSettingField(settingField);
  }

  const combatMonsterType = closestFromEventTarget(event, '[data-config-scope="setting-combat-monster-type"]');
  if (combatMonsterType && modalRefs.content.contains(combatMonsterType)) {
    return handleConfigCombatMonsterType(combatMonsterType);
  }

  const routineField = closestFromEventTarget(event, '[data-config-scope="routine-field"]');
  if (routineField && modalRefs.content.contains(routineField)) {
    return handleConfigRoutineField(routineField);
  }

  const skillRotationField = closestFromEventTarget(event, '[data-config-scope="skill-rotation-field"]');
  if (skillRotationField && modalRefs.content.contains(skillRotationField)) {
    return handleConfigSkillRotationField(skillRotationField);
  }

  const skillWeight = closestFromEventTarget(event, '[data-config-scope="skill-weight"]');
  if (skillWeight && modalRefs.content.contains(skillWeight)) {
    return handleConfigSkillWeight(skillWeight);
  }

  const skillGoal = closestFromEventTarget(event, '[data-config-scope="skill-goal"]');
  if (skillGoal && modalRefs.content.contains(skillGoal)) {
    return handleConfigSkillGoal(skillGoal);
  }

  const achievementType = closestFromEventTarget(event, '[data-config-scope="skill-achievement-type"]');
  if (achievementType && modalRefs.content.contains(achievementType)) {
    return handleConfigSkillAchievementType(achievementType);
  }

  const npcItem = closestFromEventTarget(event, '[data-config-scope="npc-buy-item"]');
  if (npcItem && modalRefs.content.contains(npcItem)) {
    return handleConfigNpcRowChange(npcItem, (row) => {
      row.code = safeText(npcItem.value, row.code);
    });
  }

  const npcMaxTotal = closestFromEventTarget(event, '[data-config-scope="npc-buy-max-total"]');
  if (npcMaxTotal && modalRefs.content.contains(npcMaxTotal)) {
    return handleConfigNpcRowChange(npcMaxTotal, (row) => {
      row.maxTotal = Math.max(1, configEditorNumberValue(npcMaxTotal, Number(row.maxTotal) || 1));
    });
  }

  return false;
}

function normalizeConfigEditorOptions(payload) {
  return isConfigEditorObject(payload) ? payload : {};
}

globalThis.__configEditorInternals = {
  buildDefaultRoutineConfig,
  cloneConfigEditorJson,
  ensureConfigEditorRoutineNode,
  getConfigEditorCharacterNames,
  getConfigEditorPathValue,
  parseConfigEditorRawText,
  setConfigEditorPathValue,
  stringifyConfigEditorDraft,
};
