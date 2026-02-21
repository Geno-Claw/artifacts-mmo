function buildCard(char, index) {
  const key = toKey(char.name);
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.charName = char.name;
  card.dataset.charKey = key;

  card.innerHTML = `
    <div class="cherry-branch">
      <canvas class="branch-canvas" data-branch="${key}" data-idx="${index}"></canvas>
    </div>
    <div class="card-inner">
      <div class="char-name" data-name="${key}">${char.name}</div>

      <div class="portrait-frame">
        <div class="portrait-border">
          <canvas class="portrait-canvas" data-portrait="${key}"></canvas>
        </div>
      </div>

      <div class="level-row">
        <span class="level-badge" data-level="${key}">LV 0</span>
      </div>

      <div class="stat-bars">
        <div class="stat-row">
          <span class="stat-label">HP</span>
          <div class="stat-bar-track">
            <div class="stat-bar-fill" data-hp-fill="${key}" style="width: 0%"></div>
          </div>
          <span class="stat-value" data-hp-text="${key}">0 / 0</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">XP</span>
          <div class="stat-bar-track xp-track">
            <div class="stat-bar-fill xp-fill" data-xp-fill="${key}" style="width: 0%"></div>
          </div>
          <span class="stat-value" data-xp-text="${key}">0 / 0</span>
        </div>
      </div>

      <div class="cooldown-section">
        <div class="cooldown-label">COOLDOWN</div>
        <div class="cooldown-bar-track">
          <div class="cooldown-bar-fill" data-cd-bar="${key}" style="width: 0%"></div>
        </div>
        <div class="cooldown-text" data-cd-text="${key}">--</div>
      </div>

      <div class="info-panel">
        <div class="info-panel-label">LOG</div>
        <div class="info-panel-text" data-log="${key}">${PLACEHOLDER_LOG}</div>
      </div>

      <div class="info-panel">
        <div class="info-panel-label">TASK</div>
        <div class="info-panel-text" data-task="${key}">OFFLINE</div>
      </div>

      <div class="buttons-section">
        <div class="btn-row">
          <button class="action-btn" type="button" data-modal-kind="equip" title="Equipment" aria-haspopup="dialog">EQUIP</button>
          <button class="action-btn" type="button" data-modal-kind="inven" title="Inventory" aria-haspopup="dialog">INVEN</button>
        </div>
        <div class="btn-row">
          <button class="action-btn" type="button" data-modal-kind="skills" title="Skills" aria-haspopup="dialog">SKILLS</button>
        </div>
        <div class="btn-row">
          <button class="action-btn" type="button" data-modal-kind="stats" title="Stats" aria-haspopup="dialog">STATS</button>
          <button class="action-btn" type="button" data-modal-kind="achiev" title="Achievements" aria-haspopup="dialog">ACHIEV</button>
        </div>
      </div>
    </div>
  `;

  const refs = {
    root: card,
    key,
    portraitType: null,
    nameEl: card.querySelector(`[data-name="${key}"]`),
    portraitCanvas: card.querySelector(`[data-portrait="${key}"]`),
    levelEl: card.querySelector(`[data-level="${key}"]`),
    hpFill: card.querySelector(`[data-hp-fill="${key}"]`),
    hpText: card.querySelector(`[data-hp-text="${key}"]`),
    xpFill: card.querySelector(`[data-xp-fill="${key}"]`),
    xpText: card.querySelector(`[data-xp-text="${key}"]`),
    cdBar: card.querySelector(`[data-cd-bar="${key}"]`),
    cdText: card.querySelector(`[data-cd-text="${key}"]`),
    logText: card.querySelector(`[data-log="${key}"]`),
    taskText: card.querySelector(`[data-task="${key}"]`),
  };

  const branchCanvas = card.querySelector(`[data-branch="${key}"]`);
  if (branchCanvas) drawCherryBranch(branchCanvas);

  cardRefs.set(char.name, refs);
  return card;
}

function updateCooldown(refs, char) {
  if (!refs || !refs.cdBar || !refs.cdText) return;
  if (char.offline) {
    refs.cdBar.style.width = '0%';
    refs.cdBar.classList.remove('ready');
    refs.cdText.classList.remove('ready-flash');
    refs.cdText.textContent = '--';
    return;
  }

  const total = char.cooldown.totalSeconds;
  const endsAtMs = char.cooldown.endsAtMs;

  if (total <= 0 || endsAtMs <= 0) {
    refs.cdBar.style.width = '100%';
    refs.cdBar.classList.add('ready');
    refs.cdText.classList.add('ready-flash');
    refs.cdText.textContent = 'READY';
    return;
  }

  const remaining = Math.max(0, (endsAtMs - Date.now()) / 1000);
  if (remaining <= 0) {
    refs.cdBar.style.width = '100%';
    refs.cdBar.classList.add('ready');
    refs.cdText.classList.add('ready-flash');
    refs.cdText.textContent = 'READY';
    return;
  }

  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  refs.cdBar.style.width = `${pct.toFixed(1)}%`;
  refs.cdBar.classList.remove('ready');
  refs.cdText.classList.remove('ready-flash');
  refs.cdText.textContent = `${remaining.toFixed(1)}s`;
}

function applyCharacterState(char) {
  const refs = cardRefs.get(char.name);
  if (!refs) return;

  refs.root.classList.toggle('offline', char.offline);
  refs.nameEl.textContent = char.name;
  refs.levelEl.textContent = `LV ${char.level}`;

  refs.hpFill.style.width = `${statPct(char.hp, char.maxHp).toFixed(1)}%`;
  refs.hpText.textContent = `${char.hp} / ${char.maxHp}`;

  refs.xpFill.style.width = `${statPct(char.xp, char.maxXp).toFixed(1)}%`;
  refs.xpText.textContent = `${char.xp} / ${char.maxXp}`;

  if (char.gameLogLatestAtMs) {
    const icon = logTypeIcon(char.gameLogLatestType);
    const time = escapeHtml(formatLogTime(char.gameLogLatestAtMs));
    const summary = formatLogSummary(char.gameLogLatestType, char.gameLogLatestDetail);
    const text = escapeHtml(summary || char.gameLogLatest);
    refs.logText.innerHTML = `${icon}<span>${time} ${text}</span>`;
    refs.logText.title = formatLogTooltip(char.gameLogLatestType, char.gameLogLatestDetail, char.gameLogLatest);
  } else {
    refs.logText.textContent = char.gameLogLatest;
    refs.logText.title = '';
  }
  refs.taskText.textContent = char.taskLabel;

  if (refs.portraitType !== char.portraitType) {
    refs.portraitType = char.portraitType;
    drawPortrait(refs.portraitCanvas, char.portraitType);
  }

  updateCooldown(refs, char);
}

function syncCards() {
  const container = document.getElementById('cardsContainer');
  const nextNames = new Set(appState.order);

  for (const [name, refs] of cardRefs.entries()) {
    if (!nextNames.has(name)) {
      refs.root.remove();
      cardRefs.delete(name);
    }
  }

  appState.order.forEach((name, index) => {
    const char = appState.characters.get(name);
    if (!char) return;

    if (!cardRefs.has(name)) {
      container.appendChild(buildCard(char, index));
    }

    const refs = cardRefs.get(name);
    if (refs && refs.root.parentElement === container) {
      container.appendChild(refs.root);
    }
    applyCharacterState(char);
  });
}
