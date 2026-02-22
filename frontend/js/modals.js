function isModalOpen() {
  return !!modalState.activeCharacterName && !!modalState.activeKind && modalRefs.host && !modalRefs.host.hidden;
}

function getModalBannerState() {
  if (modalState.activeKind === 'config') {
    return modalState.configResultBanner;
  }
  if (modalState.activeKind === 'achiev') return null;

  const snapshotChar = appState.characters.get(modalState.activeCharacterName);
  const identity = modalState.detail?.identity || {};
  const stale = !!snapshotChar?.stale || !!identity?.stale;
  const status = safeText(identity?.status, snapshotChar?.status);
  const offline = !!snapshotChar?.offline || (status && status !== 'running');

  if (!offline && !stale) return null;
  if (offline && stale) {
    return {
      tone: 'offline',
      text: 'OFFLINE / STALE - showing last known detail while runtime updates are delayed.',
    };
  }
  if (offline) {
    return {
      tone: 'offline',
      text: 'OFFLINE - runtime is not actively reporting for this character.',
    };
  }
  return {
    tone: 'stale',
    text: 'STALE - detail may lag until the next fresh runtime snapshot.',
  };
}

function renderSkillsModal(detail) {
  const rows = normalizeSkills(detail?.skills);
  if (rows.length === 0) {
    return '<div class="modal-empty">No skills available for this character.</div>';
  }

  const items = rows.map((item) => `
    <div class="modal-list-item">
      <span class="modal-list-main">${escapeHtml(item.code)}</span>
      <span class="modal-list-tag">LV ${formatNumberish(item.level, '0')}</span>
      <span class="modal-list-tag">${formatNumberish(item.xp, '0')} / ${formatNumberish(item.maxXp, '0')} (${item.pct.toFixed(0)}%)</span>
    </div>
  `).join('');

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Skill Breakdown</h3>
      <div class="modal-list">${items}</div>
    </section>
  `;
}

function renderInventoryModal(detail) {
  const rows = normalizeInventory(detail?.inventory);
  if (rows.length === 0) {
    return '<div class="modal-empty">Inventory is empty.</div>';
  }

  const items = rows.map((item) => `
    <div class="modal-list-item">
      <span class="modal-list-main">${escapeHtml(item.code)}</span>
      <span class="modal-list-slot">SLOT ${formatNumberish(item.slotIndex, '-')}</span>
      <span class="modal-list-tag">x${formatNumberish(item.quantity, '0')}</span>
    </div>
  `).join('');

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Inventory Slots</h3>
      <div class="modal-list">${items}</div>
    </section>
  `;
}

function renderEquipmentModal(detail) {
  const rows = normalizeEquipment(detail?.equipment);
  if (rows.length === 0) {
    return '<div class="modal-empty">No equipment data available.</div>';
  }

  const items = rows.map((item) => `
    <div class="modal-list-item modal-list-item--two">
      <span class="modal-list-main">${escapeHtml(item.slot)}: ${escapeHtml(item.code)}</span>
      <span class="modal-list-tag">${item.quantity > 0 ? `x${formatNumberish(item.quantity, '1')}` : 'EMPTY'}</span>
    </div>
  `).join('');

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Equipped Items</h3>
      <div class="modal-list">${items}</div>
    </section>
  `;
}

function renderBankModal(detail) {
  if (!detail || typeof detail !== 'object') {
    return '<div class="modal-empty">No bank data available.</div>';
  }

  const gold = toNumber(detail.gold, 0);
  const slots = toNumber(detail.slots, 0);
  const usedSlots = toNumber(detail.usedSlots, 0);
  const expansionCost = toNumber(detail.nextExpansionCost, 0);
  const items = Array.isArray(detail.items) ? detail.items : [];

  const summaryHtml = `
    <section class="modal-section">
      <h3 class="modal-section-title">Bank Summary</h3>
      <div class="modal-grid">
        <article class="modal-stat">
          <div class="modal-stat-label">Gold</div>
          <div class="modal-stat-value">${formatGold(gold)}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Slots Used</div>
          <div class="modal-stat-value">${usedSlots} / ${slots}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Next Expansion</div>
          <div class="modal-stat-value">${formatGold(expansionCost)} gold</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Unique Items</div>
          <div class="modal-stat-value">${items.length}</div>
        </article>
      </div>
    </section>
  `;

  if (items.length === 0) {
    return summaryHtml + '<div class="modal-empty">Bank is empty.</div>';
  }

  const itemRows = items.map((item) => `
    <div class="modal-list-item modal-list-item--two">
      <span class="modal-list-main">${escapeHtml(item.code || '--')}</span>
      <span class="modal-list-tag">x${formatNumberish(item.quantity, '0')}</span>
    </div>
  `).join('');

  return `
    ${summaryHtml}
    <section class="modal-section">
      <h3 class="modal-section-title">Bank Items (${items.length})</h3>
      <div class="modal-list">${itemRows}</div>
    </section>
  `;
}

function renderStatsModal(detail) {
  const logs = normalizeLogHistory(detail?.logHistory);

  if (logs.length === 0) {
    return '<div class="modal-empty">No log entries available for this character.</div>';
  }

  const logItems = logs.map((entry) => {
    const levelClass = entry.level === 'error'
      ? ' log-entry--error'
      : entry.level === 'warn'
        ? ' log-entry--warn'
        : '';
    return `
      <div class="modal-list-item modal-list-item--two${levelClass}">
        <span class="modal-list-main">${escapeHtml(entry.line)}</span>
        <span class="modal-list-tag">${escapeHtml(entry.level.toUpperCase())} ${escapeHtml(formatTime(entry.atMs))}</span>
      </div>
    `;
  }).join('');

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Log History (${logs.length})</h3>
      <div class="modal-log-scroll">
        <div class="modal-list">${logItems}</div>
      </div>
    </section>
  `;
}

function renderAchievementDetail(row) {
  const descriptionHtml = row.description
    ? `<div class="achievement-description">${escapeHtml(row.description)}</div>`
    : '';

  const pointsHtml = row.points > 0
    ? `<span class="achievement-points-badge">${row.points} PT${row.points !== 1 ? 'S' : ''}</span>`
    : '';

  const objectivesHtml = row.objectives.map(obj => {
    const targetLabel = obj.target
      ? `${escapeHtml(obj.type)}: ${escapeHtml(obj.target)}`
      : escapeHtml(obj.type || 'objective');
    const pct = obj.total > 0 ? Math.round(obj.pct) : 0;
    const progressText = obj.total > 0
      ? `${formatNumberish(obj.current, '0')} / ${formatNumberish(obj.total, '0')}`
      : '--';
    const barFillClass = obj.completed ? ' is-complete' : '';

    return `
      <div class="achievement-objective">
        <span class="achievement-objective-target">${targetLabel}</span>
        <span class="achievement-objective-progress">${escapeHtml(progressText)}</span>
        ${obj.total > 0 ? `
          <div class="achievement-objective-bar">
            <div class="achievement-objective-bar-fill${barFillClass}" style="width:${pct}%"></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  let rewardsHtml = '';
  const rewardParts = [];
  if (row.rewards.gold > 0) {
    rewardParts.push(`<span class="achievement-reward-item">${formatNumberish(row.rewards.gold, '0')} gold</span>`);
  }
  for (const ri of row.rewards.items) {
    rewardParts.push(`<span class="achievement-reward-item">${ri.quantity}x ${escapeHtml(ri.code)}</span>`);
  }
  if (rewardParts.length > 0) {
    rewardsHtml = `
      <div class="achievement-rewards">
        <span class="achievement-meta-label">REWARDS:</span> ${rewardParts.join('')}
      </div>
    `;
  }

  return `
    ${descriptionHtml}
    <div class="achievement-meta-row">
      ${pointsHtml}
    </div>
    ${objectivesHtml}
    ${rewardsHtml}
  `;
}

function renderAchievementsModal(detail) {
  const summary = detail?.summary && typeof detail.summary === 'object' ? detail.summary : {};
  const completed = Math.max(0, toNumber(summary.completed, 0));
  const total = Math.max(completed, toNumber(summary.total, 0));
  const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const totalPoints = Math.max(0, toNumber(summary.totalPoints, 0));
  const filter = getAchievementFilterValue();
  const typeFilter = getAchievementTypeFilterValue();
  const searchValue = `${modalState.achievementSearch ?? ''}`;

  const typeFilterButtons = Object.entries(ACHIEVEMENT_TYPE_FILTER_LABELS).map(([value, label]) => `
    <button
      type="button"
      class="achievement-filter-btn${value === typeFilter ? ' is-active' : ''}"
      data-achievement-type-filter="${value}"
    >${escapeHtml(label.toUpperCase())}</button>
  `).join('');

  const filterButtons = Object.entries(ACHIEVEMENT_FILTER_LABELS).map(([value, label]) => `
    <button
      type="button"
      class="achievement-filter-btn${value === filter ? ' is-active' : ''}"
      data-achievement-filter="${value}"
    >${escapeHtml(label.toUpperCase())}</button>
  `).join('');

  return `
    <section class="modal-section">
      <h3 class="modal-section-title">Account Totals</h3>
      <div class="modal-grid">
        <article class="modal-stat">
          <div class="modal-stat-label">Completed</div>
          <div class="modal-stat-value">${formatNumberish(completed, '0')}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Total Available</div>
          <div class="modal-stat-value">${formatNumberish(total, '0')}</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Completion</div>
          <div class="modal-stat-value">${formatNumberish(completionPct, '0')}%</div>
        </article>
        <article class="modal-stat">
          <div class="modal-stat-label">Points Earned</div>
          <div class="modal-stat-value">${formatNumberish(totalPoints, '0')}</div>
        </article>
      </div>
    </section>
    <section class="modal-section">
      <h3 class="modal-section-title">Achievements</h3>
      <div class="achievement-type-filter-row" role="tablist" aria-label="Achievement type filters">
        ${typeFilterButtons}
      </div>
      <div class="achievement-toolbar">
        <div class="achievement-filter-group" role="tablist" aria-label="Achievement status filters">
          ${filterButtons}
        </div>
        <label class="achievement-search">
          <span class="achievement-search-label">SEARCH</span>
          <input
            type="search"
            class="achievement-search-input"
            data-achievement-search
            placeholder="Code, title, or description"
            value="${escapeHtml(searchValue)}"
            autocomplete="off"
          >
        </label>
      </div>
      <div class="achievement-result-count" data-achievement-result-count></div>
      <div class="modal-list" data-achievement-list></div>
    </section>
  `;
}

function renderConfigModal(detail) {
  const configPath = safeText(detail?.configPath, '--');
  const hash = safeText(modalState.configIfMatchHash, '--');
  const updatedAt = formatTime(detail?.updatedAtMs);
  const editorText = `${modalState.configEditorText ?? ''}`;
  const validationErrors = Array.isArray(modalState.configValidationErrors)
    ? modalState.configValidationErrors
    : [];
  const busy = modalState.configBusy;
  const busyAttr = busy ? ' disabled' : '';

  const validationHtml = validationErrors.length > 0
    ? `
      <section class="modal-section">
        <h3 class="modal-section-title">Validation Errors</h3>
        <div class="config-validation-list">
          ${validationErrors.map((row) => `
            <div class="config-validation-item">
              <span class="config-validation-path">${escapeHtml(safeText(row.path, '$'))}</span>
              <span class="config-validation-message">${escapeHtml(safeText(row.message, 'Validation error'))}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `
    : '';

  return `
    <div class="config-editor">
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
      <section class="modal-section">
        <h3 class="modal-section-title">Raw JSON</h3>
        <textarea
          class="config-editor-textarea"
          data-config-json
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          aria-label="Raw config JSON editor"${busyAttr}
        >${escapeHtml(editorText)}</textarea>
      </section>
      <section class="modal-section">
        <h3 class="modal-section-title">Actions</h3>
        <div class="config-editor-actions">
          <button type="button" class="config-editor-btn" data-config-action="validate"${busyAttr}>VALIDATE</button>
          <button type="button" class="config-editor-btn" data-config-action="save"${busyAttr}>SAVE</button>
        </div>
      </section>
      ${validationHtml}
    </div>
  `;
}

function renderAchievementsListInPlace() {
  if (!modalRefs.content || modalState.activeKind !== 'achiev' || modalState.status !== 'ready' || !modalState.detail) {
    return;
  }

  const listHost = modalRefs.content.querySelector('[data-achievement-list]');
  const countHost = modalRefs.content.querySelector('[data-achievement-result-count]');
  if (!listHost) return;

  const rows = Array.isArray(modalState.detail.achievements) ? modalState.detail.achievements : [];
  const visibleRows = filterAchievements(rows);
  const activeFilter = getAchievementFilterValue();
  const activeTypeFilter = getAchievementTypeFilterValue();
  const expanded = modalState.achievementExpandedSet;

  modalRefs.content.querySelectorAll('button[data-achievement-filter]').forEach((button) => {
    const value = safeText(button.dataset.achievementFilter, '');
    button.classList.toggle('is-active', value === activeFilter);
  });
  modalRefs.content.querySelectorAll('button[data-achievement-type-filter]').forEach((button) => {
    const value = safeText(button.dataset.achievementTypeFilter, '');
    button.classList.toggle('is-active', value === activeTypeFilter);
  });

  if (countHost) {
    if (rows.length === 0) {
      countHost.textContent = 'No achievements available.';
    } else {
      countHost.textContent = `Showing ${formatNumberish(visibleRows.length, '0')} of ${formatNumberish(rows.length, '0')} achievements.`;
    }
  }

  if (rows.length === 0) {
    listHost.innerHTML = '<div class="modal-empty">No achievements available for this account.</div>';
    return;
  }

  if (visibleRows.length === 0) {
    listHost.innerHTML = '<div class="modal-empty">No achievements match the selected filter or search.</div>';
    return;
  }

  listHost.innerHTML = visibleRows.map((row) => {
    const state = getAchievementState(row);
    const statusLabel = state === 'completed'
      ? 'COMPLETED'
      : (state === 'in-progress' ? 'IN PROGRESS' : 'NOT STARTED');
    const isExpanded = expanded.has(row.code);
    const expandedClass = isExpanded ? ' is-expanded' : '';
    const detailVisible = isExpanded ? ' is-visible' : '';

    return `
      <div class="modal-list-item modal-list-item--two achievement-row${expandedClass}"
           data-achievement-toggle="${escapeHtml(row.code)}">
        <span class="modal-list-main achievement-list-main">
          <span class="achievement-expand-icon">&#9654;</span>
          <span class="achievement-code">${escapeHtml(row.code)}</span>
          <span class="achievement-title">${escapeHtml(row.title)}</span>
        </span>
        <span class="achievement-progress">
          <span class="achievement-status is-${state}">${statusLabel}</span>
          <span class="modal-list-tag">${escapeHtml(getAchievementProgressText(row))}</span>
        </span>
      </div>
      <div class="achievement-detail${detailVisible}" data-achievement-detail="${escapeHtml(row.code)}">
        ${renderAchievementDetail(row)}
      </div>
    `;
  }).join('');
}

function renderModalContent() {
  if (!modalRefs.content) return;

  const kindLabel = MODAL_KIND_LABELS[modalState.activeKind] || 'Detail';
  if (modalState.status === 'loading') {
    modalRefs.content.innerHTML = `<div class="modal-state">Loading ${escapeHtml(kindLabel)}...</div>`;
    return;
  }

  if (modalState.status === 'error') {
    const message = safeText(modalState.errorText, 'Unknown error');
    modalRefs.content.innerHTML = `
      <div class="modal-error">
        Unable to load ${escapeHtml(kindLabel)}.
        <span class="modal-log-line">${escapeHtml(message)}</span>
      </div>
    `;
    return;
  }

  if (modalState.status !== 'ready' || !modalState.detail) {
    modalRefs.content.innerHTML = '<div class="modal-state">Select a detail view.</div>';
    return;
  }

  if (modalState.activeKind === 'skills') {
    modalRefs.content.innerHTML = renderSkillsModal(modalState.detail);
    return;
  }
  if (modalState.activeKind === 'inven') {
    modalRefs.content.innerHTML = renderInventoryModal(modalState.detail);
    return;
  }
  if (modalState.activeKind === 'equip') {
    modalRefs.content.innerHTML = renderEquipmentModal(modalState.detail);
    return;
  }
  if (modalState.activeKind === 'achiev') {
    modalRefs.content.innerHTML = renderAchievementsModal(modalState.detail);
    renderAchievementsListInPlace();
    return;
  }
  if (modalState.activeKind === 'config') {
    modalRefs.content.innerHTML = renderConfigModal(modalState.detail);
    return;
  }
  if (modalState.activeKind === 'bank') {
    modalRefs.content.innerHTML = renderBankModal(modalState.detail);
    return;
  }
  modalRefs.content.innerHTML = renderStatsModal(modalState.detail);
}

function renderModal() {
  if (!isModalOpen()) return;

  const label = MODAL_KIND_LABELS[modalState.activeKind] || 'Detail';
  if (modalRefs.kind) modalRefs.kind.textContent = label.toUpperCase();
  if (modalRefs.title) {
    if (modalState.activeKind === 'achiev') {
      const accountName = safeText(modalState.detail?.summary?.account, 'Account');
      modalRefs.title.textContent = `${accountName} - ${label}`;
    } else if (modalState.activeKind === 'config') {
      modalRefs.title.textContent = `Runtime Config - ${label}`;
    } else if (modalState.activeKind === 'bank') {
      modalRefs.title.textContent = `Account ${label}`;
    } else {
      modalRefs.title.textContent = `${modalState.activeCharacterName} - ${label}`;
    }
  }

  if (modalRefs.banner) {
    const banner = getModalBannerState();
    if (!banner) {
      modalRefs.banner.hidden = true;
      modalRefs.banner.className = 'modal-banner';
      modalRefs.banner.textContent = '';
    } else {
      modalRefs.banner.hidden = false;
      modalRefs.banner.className = `modal-banner ${banner.tone}`;
      modalRefs.banner.textContent = banner.text;
    }
  }

  renderModalContent();
}
