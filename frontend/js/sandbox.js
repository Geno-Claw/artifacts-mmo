/* ==============================================================
   SANDBOX CONTROLS
   Provides UI for sandbox-only operations (give gold/items/XP,
   spawn events, reset account). Only visible when the bot is
   connected to the sandbox server.
   ============================================================== */

function isSandboxModalOpen() {
  return sandboxRefs.host && !sandboxRefs.host.hidden;
}

function openSandboxModal() {
  if (!sandboxRefs.host) return;
  sandboxRefs.host.hidden = false;
  document.body.classList.add('modal-open');
  renderSandboxModalContent();
}

function closeSandboxModal() {
  if (!sandboxRefs.host) return;
  sandboxRefs.host.hidden = true;
  document.body.classList.remove('modal-open');
  clearSandboxBanner();
}

function setSandboxBanner(message, tone) {
  sandboxState.resultMessage = message;
  sandboxState.resultTone = tone;
  if (sandboxState.resetTimer) clearTimeout(sandboxState.resetTimer);
  sandboxState.resetTimer = setTimeout(clearSandboxBanner, 5000);
  renderSandboxBanner();
}

function clearSandboxBanner() {
  sandboxState.resultMessage = '';
  sandboxState.resultTone = '';
  if (sandboxState.resetTimer) {
    clearTimeout(sandboxState.resetTimer);
    sandboxState.resetTimer = null;
  }
  renderSandboxBanner();
}

function renderSandboxBanner() {
  if (!sandboxRefs.banner) return;
  if (!sandboxState.resultMessage) {
    sandboxRefs.banner.hidden = true;
    sandboxRefs.banner.textContent = '';
    return;
  }
  sandboxRefs.banner.hidden = false;
  sandboxRefs.banner.className = `modal-banner ${sandboxState.resultTone || ''}`;
  sandboxRefs.banner.textContent = sandboxState.resultMessage;
}

function buildCharacterOptions() {
  const chars = sandboxState.characters;
  if (!chars.length) return '<option value="">No characters</option>';
  return chars.map(name =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
  ).join('');
}

function buildSelectOptions(items, valueKey, labelKey) {
  return items.map(item =>
    `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey])}</option>`
  ).join('');
}

function renderSandboxModalContent() {
  if (!sandboxRefs.content) return;

  const charOpts = buildCharacterOptions();
  const xpOpts = SANDBOX_XP_TYPES.map(t =>
    `<option value="${escapeHtml(t)}">${escapeHtml(formatUpperToken(t))}</option>`
  ).join('');
  const eventOpts = buildSelectOptions(SANDBOX_EVENTS, 'code', 'name');

  sandboxRefs.content.innerHTML = `
    <section class="sandbox-form-section">
      <h3 class="modal-section-title">Give Gold</h3>
      <form class="sandbox-form" data-sandbox-action="give-gold">
        <div class="sandbox-form-row">
          <label class="sandbox-label">Character</label>
          <select class="sandbox-select" name="character">${charOpts}</select>
        </div>
        <div class="sandbox-form-row">
          <label class="sandbox-label">Quantity</label>
          <input class="sandbox-input" type="number" name="quantity" min="1" value="10000" required>
        </div>
        <button type="submit" class="action-btn sandbox-submit-btn">GIVE GOLD</button>
      </form>
    </section>

    <section class="sandbox-form-section">
      <h3 class="modal-section-title">Give Item</h3>
      <form class="sandbox-form" data-sandbox-action="give-item">
        <div class="sandbox-form-row">
          <label class="sandbox-label">Character</label>
          <select class="sandbox-select" name="character">${charOpts}</select>
        </div>
        <div class="sandbox-form-row">
          <label class="sandbox-label">Item Code</label>
          <input class="sandbox-input" type="text" name="code" placeholder="e.g. copper_ore" required>
        </div>
        <div class="sandbox-form-row">
          <label class="sandbox-label">Quantity</label>
          <input class="sandbox-input" type="number" name="quantity" min="1" value="100" required>
        </div>
        <button type="submit" class="action-btn sandbox-submit-btn">GIVE ITEM</button>
      </form>
    </section>

    <section class="sandbox-form-section">
      <h3 class="modal-section-title">Give XP</h3>
      <form class="sandbox-form" data-sandbox-action="give-xp">
        <div class="sandbox-form-row">
          <label class="sandbox-label">Character</label>
          <select class="sandbox-select" name="character">${charOpts}</select>
        </div>
        <div class="sandbox-form-row">
          <label class="sandbox-label">Skill</label>
          <select class="sandbox-select" name="type">${xpOpts}</select>
        </div>
        <div class="sandbox-form-row">
          <label class="sandbox-label">Amount</label>
          <input class="sandbox-input" type="number" name="amount" min="1" max="100000" value="10000" required>
        </div>
        <button type="submit" class="action-btn sandbox-submit-btn">GIVE XP</button>
      </form>
    </section>

    <section class="sandbox-form-section">
      <h3 class="modal-section-title">Spawn Event</h3>
      <form class="sandbox-form" data-sandbox-action="spawn-event">
        <div class="sandbox-form-row">
          <label class="sandbox-label">Event</label>
          <select class="sandbox-select" name="code">${eventOpts}</select>
        </div>
        <button type="submit" class="action-btn sandbox-submit-btn">SPAWN EVENT</button>
      </form>
    </section>

    <section class="sandbox-form-section">
      <h3 class="modal-section-title">Reset Account</h3>
      <p class="sandbox-warning">Deletes all characters, bank items, achievements, and progress.</p>
      <form class="sandbox-form" data-sandbox-action="reset-account">
        <button type="submit" class="action-btn sandbox-danger-btn">RESET ACCOUNT</button>
      </form>
    </section>
  `;
}

async function handleSandboxSubmit(form) {
  const action = form.dataset.sandboxAction;
  if (!action) return;

  if (action === 'reset-account') {
    if (!confirm('Are you sure you want to reset your sandbox account? This will delete ALL characters, bank items, achievements, and progress.')) {
      return;
    }
  }

  const formData = new FormData(form);
  const body = {};
  for (const [key, value] of formData.entries()) {
    body[key] = value;
  }

  // Convert numeric fields
  if (body.quantity) body.quantity = Number(body.quantity);
  if (body.amount) body.amount = Number(body.amount);

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const base = window.__BASE_PATH__ || '';
    const res = await fetch(`${base}/api/sandbox/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await res.json();

    if (res.ok) {
      const messages = {
        'give-gold': `Gave ${formatNumberish(body.quantity)} gold to ${body.character}`,
        'give-item': `Gave ${formatNumberish(body.quantity)}x ${body.code} to ${body.character}`,
        'give-xp': `Gave ${formatNumberish(body.amount)} ${formatUpperToken(body.type)} XP to ${body.character}`,
        'spawn-event': `Spawned event: ${body.code}`,
        'reset-account': 'Account reset successfully',
      };
      setSandboxBanner(messages[action] || 'Success', 'success');
    } else {
      const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
      setSandboxBanner(`Error: ${detail}`, 'error');
    }
  } catch (err) {
    setSandboxBanner(`Error: ${err.message}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function onSandboxContentClick(event) {
  // Handle form submissions via delegation
  const form = closestFromEventTarget(event, 'form.sandbox-form');
  if (form && event.target?.type === 'submit') {
    event.preventDefault();
    handleSandboxSubmit(form);
  }
}

function onSandboxContentSubmit(event) {
  const form = event.target;
  if (form?.classList?.contains('sandbox-form')) {
    event.preventDefault();
    handleSandboxSubmit(form);
  }
}

async function probeSandboxAvailability() {
  runtimeFeatures.sandboxAvailable = false;
  sandboxState.characters = [];
  applySandboxFeatureVisibility();

  try {
    const base = window.__BASE_PATH__ || '';
    const res = await fetch(`${base}/api/sandbox/status`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.sandbox) {
      runtimeFeatures.sandboxAvailable = true;
      sandboxState.characters = Array.isArray(data.characters) ? data.characters : [];
    }
  } catch {
    runtimeFeatures.sandboxAvailable = false;
  }

  applySandboxFeatureVisibility();
}

function applySandboxFeatureVisibility() {
  if (sandboxRefs.openBtn) {
    sandboxRefs.openBtn.hidden = !runtimeFeatures.sandboxAvailable;
  }
}
