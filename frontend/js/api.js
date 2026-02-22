function abortModalFetch() {
  if (modalState.fetchController) {
    modalState.fetchController.abort();
    modalState.fetchController = null;
  }
  if (modalState.configActionController) {
    modalState.configActionController.abort();
    modalState.configActionController = null;
    modalState.configBusy = false;
  }
}

async function fetchCharacterDetail(name) {
  if (!isModalOpen() || modalState.activeCharacterName !== name) return;

  abortModalFetch();
  const controller = new AbortController();
  const seq = modalState.fetchSeq + 1;
  modalState.fetchSeq = seq;
  modalState.fetchController = controller;
  modalState.status = 'loading';
  modalState.errorText = '';
  renderModal();

  try {
    const res = await fetch(`${window.__BASE_PATH__||''}/api/ui/character/${encodeURIComponent(name)}`, {
      cache: 'no-store',
      signal: controller.signal,
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const errText = safeText(payload?.error, `HTTP ${res.status}`);
      const errDetail = safeText(payload?.detail, '');
      let message = errDetail ? `${errText}: ${errDetail}` : errText;
      if (res.status === 404 && errText === 'not_found') {
        message = `${message}. Restart runtime to load latest dashboard routes.`;
      }
      throw new Error(message);
    }

    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeCharacterName !== name) {
      return;
    }

    modalState.detail = payload || {};
    modalState.status = 'ready';
    modalState.errorText = '';
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeCharacterName !== name) {
      return;
    }
    modalState.status = 'error';
    modalState.errorText = safeText(err?.message, 'Failed to fetch character detail');
  } finally {
    if (modalState.fetchController === controller) {
      modalState.fetchController = null;
    }
    renderModal();
  }
}

function buildApiErrorMessage(response, payload, prefix) {
  const data = extractApiData(payload);
  const base = safeText(payload?.error ?? data?.error, `HTTP ${response.status}`);
  const detail = safeText(payload?.detail ?? data?.detail, '');
  return detail ? `${prefix}: ${base}: ${detail}` : `${prefix}: ${base}`;
}

async function fetchControlStatus({ silentErrors = false } = {}) {
  if (controlState.statusController) {
    controlState.statusController.abort();
  }

  const controller = new AbortController();
  const seq = controlState.statusSeq + 1;
  controlState.statusSeq = seq;
  controlState.statusController = controller;

  try {
    const res = await fetch((window.__BASE_PATH__||'')+'/api/control/status', {
      cache: 'no-store',
      signal: controller.signal,
    });
    const payloadRaw = await res.json().catch(() => null);
    if (controlState.statusSeq !== seq) return null;

    if (res.status === 404) {
      runtimeFeatures.controlPanelAvailable = false;
      controlState.statusSnapshot = null;
      controlState.statusError = '';
      setControlOperationState('idle');
      setControlResultBanner('', '');
      stopControlStatusPolling();
      renderControlPanel();
      return null;
    }

    runtimeFeatures.controlPanelAvailable = true;

    if (!res.ok) {
      const message = buildApiErrorMessage(res, payloadRaw, 'Control status failed');
      controlState.statusError = message;
      controlState.statusSnapshot = {
        lifecycle: 'error',
        inFlight: false,
        operationAction: '',
        updatedAtMs: Date.now(),
        detail: message,
      };
      if (!silentErrors) {
        setControlResultBanner('warning', `CONTROL STATUS FAILURE - ${message}`);
      }
      renderControlPanel();
      return controlState.statusSnapshot;
    }

    controlState.statusSnapshot = normalizeControlStatusSnapshot(payloadRaw);
    controlState.statusError = '';
    renderControlPanel();
    return controlState.statusSnapshot;
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    if (controlState.statusSeq !== seq) return null;

    controlState.statusError = safeText(err?.message, 'Control status request failed');
    if (!controlState.statusSnapshot) {
      controlState.statusSnapshot = {
        lifecycle: 'unknown',
        inFlight: false,
        operationAction: '',
        updatedAtMs: Date.now(),
        detail: '',
      };
    }
    if (!silentErrors) {
      setControlResultBanner('warning', `CONTROL STATUS FAILURE - ${controlState.statusError}`);
    }
    renderControlPanel();
    return controlState.statusSnapshot;
  } finally {
    if (controlState.statusController === controller) {
      controlState.statusController = null;
    }
  }
}

async function runRuntimeControlAction(action) {
  const normalizedAction = normalizeControlAction(action, '');
  if (!normalizedAction || !runtimeFeatures.controlPanelAvailable) return;
  if (controlState.operationState === 'in-flight') return;
  if (controlState.statusSnapshot?.inFlight) {
    setControlOperationState('failure', { action: normalizedAction });
    setControlResultBanner('warning', 'CONTROL LOCKED - another runtime operation is already in-flight.');
    renderControlPanel();
    return;
  }

  if (controlState.actionController) {
    controlState.actionController.abort();
  }
  const controller = new AbortController();
  controlState.actionController = controller;
  let requestTimedOut = false;
  const requestTimeoutTimer = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, CONTROL_ACTION_REQUEST_TIMEOUT_MS);
  requestTimeoutTimer.unref?.();

  const actionLabel = formatUpperToken(getControlActionLabel(normalizedAction, normalizedAction), 'CONTROL');
  setControlOperationState('in-flight', { action: normalizedAction });
  setControlResultBanner('info', `${actionLabel} IN-FLIGHT...`);
  renderControlPanel();

  try {
    const res = await fetch(CONTROL_ACTION_ENDPOINTS[normalizedAction], {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const payloadRaw = await res.json().catch(() => null);

    if (res.status === 404) {
      runtimeFeatures.controlPanelAvailable = false;
      setControlOperationState('failure', { action: normalizedAction });
      setControlResultBanner('error', 'CONTROL UNAVAILABLE (404) - runtime control routes were not found.');
      stopControlStatusPolling();
      renderControlPanel();
      return;
    }

    if (!res.ok) {
      const message = buildApiErrorMessage(res, payloadRaw, `${getControlActionLabel(normalizedAction, 'Control action')} failed`);
      setControlOperationState('failure', { action: normalizedAction });
      setControlResultBanner('error', `${actionLabel} FAILURE - ${message}`);
      renderControlPanel();
      await fetchControlStatus({ silentErrors: true });
      return;
    }

    const payload = extractApiData(payloadRaw);
    const detail = safeText(
      payload?.detail ?? payloadRaw?.detail ?? payload?.message ?? payloadRaw?.message,
      ''
    );

    setControlOperationState('success', { action: normalizedAction });
    setControlResultBanner('success', `${actionLabel} SUCCESS${detail ? ` - ${detail}` : ''}.`);
    renderControlPanel();
    await fetchControlStatus({ silentErrors: true });
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (requestTimedOut) {
        const timeoutSeconds = Math.max(1, Math.floor(CONTROL_ACTION_REQUEST_TIMEOUT_MS / 1000));
        setControlOperationState('idle');
        setControlResultBanner(
          'warning',
          `${actionLabel} REQUEST TIMED OUT AFTER ${timeoutSeconds}S - operation may still be running; syncing status.`
        );
        renderControlPanel();
        await fetchControlStatus({ silentErrors: true });
      } else {
        setControlOperationState('idle');
      }
      return;
    }
    setControlOperationState('failure', { action: normalizedAction });
    setControlResultBanner('error', `${actionLabel} FAILURE - ${safeText(err?.message, 'Request failed')}`);
    renderControlPanel();
    await fetchControlStatus({ silentErrors: true });
  } finally {
    clearTimeout(requestTimeoutTimer);
    if (controlState.actionController === controller) {
      controlState.actionController = null;
    }
    renderControlPanel();
  }
}

async function fetchConfigDetail() {
  if (!isModalOpen() || modalState.activeKind !== 'config') return;

  abortModalFetch();
  const controller = new AbortController();
  const seq = modalState.fetchSeq + 1;
  modalState.fetchSeq = seq;
  modalState.fetchController = controller;
  modalState.status = 'loading';
  modalState.errorText = '';
  modalState.configBusy = false;
  modalState.configValidationErrors = [];
  setConfigResultBanner('', '');
  renderModal();

  try {
    const res = await fetch((window.__BASE_PATH__||'')+'/api/config', {
      cache: 'no-store',
      signal: controller.signal,
    });
    const payloadRaw = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(buildApiErrorMessage(res, payloadRaw, 'Config load failed'));
    }

    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'config') {
      return;
    }

    const envelope = normalizeConfigEnvelope(payloadRaw, { requireJson: true });
    modalState.detail = {
      configPath: envelope.configPath,
      updatedAtMs: envelope.updatedAtMs,
    };
    modalState.configEditorText = envelope.rawJson;
    modalState.configIfMatchHash = envelope.ifMatchHash;
    modalState.status = 'ready';
    modalState.errorText = '';
    modalState.configValidationErrors = [];
    setConfigResultBanner('', '');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'config') {
      return;
    }
    modalState.status = 'error';
    modalState.errorText = safeText(err?.message, 'Failed to load config');
  } finally {
    if (modalState.fetchController === controller) {
      modalState.fetchController = null;
    }
    renderModal();
  }
}

async function runConfigValidate() {
  if (!isModalOpen() || modalState.activeKind !== 'config' || modalState.status !== 'ready' || modalState.configBusy) {
    return;
  }

  const parsed = parseConfigEditorJson();
  if (!parsed.ok) {
    renderModal();
    return;
  }

  if (modalState.configActionController) {
    modalState.configActionController.abort();
  }
  const controller = new AbortController();
  modalState.configActionController = controller;
  modalState.configBusy = true;
  renderModal();

  try {
    const res = await fetch((window.__BASE_PATH__||'')+'/api/config/validate', {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildConfigRequestPayload(parsed.value)),
    });

    const payloadRaw = await res.json().catch(() => null);
    if (!isModalOpen() || modalState.activeKind !== 'config') return;

    const payload = extractApiData(payloadRaw);
    const errors = normalizeValidationErrors(payloadRaw);
    const explicitOk = payload && typeof payload === 'object' && typeof payload.ok === 'boolean'
      ? payload.ok
      : null;
    const validationPassed = res.ok && explicitOk !== false && errors.length === 0;

    if (validationPassed) {
      modalState.configValidationErrors = [];
      setConfigResultBanner('success', 'VALIDATE SUCCESS - config schema checks passed.');
      return;
    }

    modalState.configValidationErrors = errors;
    if (modalState.configValidationErrors.length === 0) {
      const fallbackMessage = safeText(
        payload?.detail ?? payloadRaw?.detail ?? payload?.error ?? payloadRaw?.error,
        'Validation failed'
      );
      modalState.configValidationErrors = [{ path: '$', message: fallbackMessage }];
    }
    setConfigResultBanner('warning', 'VALIDATE FAILURE - review inline path + message errors.');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.activeKind !== 'config') return;
    modalState.configValidationErrors = [];
    setConfigResultBanner('error', `VALIDATE FAILURE - ${safeText(err?.message, 'Request failed')}`);
  } finally {
    if (modalState.configActionController === controller) {
      modalState.configActionController = null;
      modalState.configBusy = false;
    }
    renderModal();
  }
}

async function runConfigSave() {
  if (!isModalOpen() || modalState.activeKind !== 'config' || modalState.status !== 'ready' || modalState.configBusy) {
    return;
  }

  const parsed = parseConfigEditorJson();
  if (!parsed.ok) {
    renderModal();
    return;
  }

  if (modalState.configActionController) {
    modalState.configActionController.abort();
  }
  const controller = new AbortController();
  modalState.configActionController = controller;
  modalState.configBusy = true;
  renderModal();

  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    const ifMatchHash = safeText(modalState.configIfMatchHash, '');
    if (ifMatchHash) {
      headers['If-Match'] = ifMatchHash;
    }

    const res = await fetch((window.__BASE_PATH__||'')+'/api/config', {
      method: 'PUT',
      cache: 'no-store',
      signal: controller.signal,
      headers,
      body: JSON.stringify(buildConfigRequestPayload(parsed.value)),
    });
    const payloadRaw = await res.json().catch(() => null);
    if (!isModalOpen() || modalState.activeKind !== 'config') return;

    if (res.status === 409) {
      modalState.configValidationErrors = normalizeValidationErrors(payloadRaw);
      if (modalState.configValidationErrors.length === 0) {
        const detail = safeText(payloadRaw?.detail ?? extractApiData(payloadRaw)?.detail, '');
        if (detail) modalState.configValidationErrors = [{ path: '$', message: detail }];
      }
      setConfigResultBanner('warning', 'SAVE CONFLICT (409) - loaded hash is stale; reload before retry.');
      return;
    }

    if (!res.ok) {
      const errors = normalizeValidationErrors(payloadRaw);
      modalState.configValidationErrors = errors;
      if (modalState.configValidationErrors.length === 0) {
        modalState.configValidationErrors = [{
          path: '$',
          message: buildApiErrorMessage(res, payloadRaw, 'Save failed'),
        }];
      }
      setConfigResultBanner('error', 'SAVE FAILURE - config was not persisted.');
      return;
    }

    const payload = extractApiData(payloadRaw);
    if (payload && typeof payload === 'object' && payload.ok === false) {
      modalState.configValidationErrors = normalizeValidationErrors(payloadRaw);
      if (modalState.configValidationErrors.length === 0) {
        const detail = safeText(payload.detail, 'Save failed');
        modalState.configValidationErrors = [{ path: '$', message: detail }];
      }
      setConfigResultBanner('error', 'SAVE FAILURE - config was not persisted.');
      return;
    }

    const envelope = normalizeConfigEnvelope(payloadRaw, { requireJson: false });
    if (safeText(envelope.rawJson, '')) {
      modalState.configEditorText = envelope.rawJson;
    }
    if (safeText(envelope.ifMatchHash, '')) {
      modalState.configIfMatchHash = envelope.ifMatchHash;
    }
    modalState.detail = {
      configPath: envelope.configPath || safeText(modalState.detail?.configPath, ''),
      updatedAtMs: envelope.updatedAtMs || Date.now(),
    };
    modalState.configValidationErrors = [];
    setConfigResultBanner('success', 'SAVE SUCCESS - config persisted.');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.activeKind !== 'config') return;
    modalState.configValidationErrors = [];
    setConfigResultBanner('error', `SAVE FAILURE - ${safeText(err?.message, 'Request failed')}`);
  } finally {
    if (modalState.configActionController === controller) {
      modalState.configActionController = null;
      modalState.configBusy = false;
    }
    renderModal();
  }
}

async function fetchAccountAchievementsDetail() {
  if (!isModalOpen() || modalState.activeKind !== 'achiev') return;

  abortModalFetch();
  const controller = new AbortController();
  const seq = modalState.fetchSeq + 1;
  modalState.fetchSeq = seq;
  modalState.fetchController = controller;
  modalState.status = 'loading';
  modalState.errorText = '';
  renderModal();

  try {
    const [summaryRes, achievementsRes] = await Promise.all([
      fetch((window.__BASE_PATH__||'')+'/api/ui/account/summary', {
        cache: 'no-store',
        signal: controller.signal,
      }),
      fetch((window.__BASE_PATH__||'')+'/api/ui/account/achievements', {
        cache: 'no-store',
        signal: controller.signal,
      }),
    ]);

    const [summaryPayloadRaw, achievementsPayloadRaw] = await Promise.all([
      summaryRes.json().catch(() => null),
      achievementsRes.json().catch(() => null),
    ]);

    if (!summaryRes.ok) {
      throw new Error(buildApiErrorMessage(summaryRes, summaryPayloadRaw, 'Account summary request failed'));
    }
    if (!achievementsRes.ok) {
      throw new Error(buildApiErrorMessage(achievementsRes, achievementsPayloadRaw, 'Achievements request failed'));
    }

    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'achiev') {
      return;
    }

    const summaryPayload = extractApiData(summaryPayloadRaw) || {};
    const achievementsPayload = extractApiData(achievementsPayloadRaw) || {};
    const achievementRows = normalizeAchievements(
      Array.isArray(achievementsPayload)
        ? achievementsPayload
        : (achievementsPayload?.achievements ?? achievementsPayload?.items ?? achievementsPayload?.rows ?? [])
    );
    const summary = normalizeAchievementSummary(summaryPayload, achievementRows);

    modalState.detail = {
      summary,
      achievements: achievementRows,
      updatedAtMs: Math.max(
        0,
        toNumber(achievementsPayload?.updatedAtMs ?? summaryPayload?.updatedAtMs ?? summaryPayload?.updatedAt, 0)
      ),
    };
    modalState.status = 'ready';
    modalState.errorText = '';
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'achiev') {
      return;
    }
    modalState.status = 'error';
    modalState.errorText = safeText(err?.message, 'Failed to fetch account achievements');
  } finally {
    if (modalState.fetchController === controller) {
      modalState.fetchController = null;
    }
    renderModal();
  }
}

function openCharacterModal(name, kind) {
  if (!name || !MODAL_KIND_LABELS[kind] || !modalRefs.host || !modalRefs.dialog) return;
  if (kind === 'config') {
    openConfigModal();
    return;
  }
  if (kind === 'bank') {
    openBankModal();
    return;
  }
  if (kind === 'achiev') {
    openAchievementsModal();
    return;
  }

  modalState.lastFocusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  modalState.activeCharacterName = name;
  modalState.activeKind = kind;
  modalState.status = 'loading';
  modalState.detail = null;
  modalState.errorText = '';
  modalState.activeSnapshotUpdatedAtMs = appState.characters.get(name)?.lastUpdatedAtMs || 0;
  modalState.achievementFilter = 'all';
  modalState.achievementTypeFilter = 'all';
  modalState.achievementExpandedSet.clear();
  modalState.achievementSearch = '';
  modalState.configEditorText = '';
  modalState.configIfMatchHash = '';
  modalState.configValidationErrors = [];
  modalState.configBusy = false;
  setConfigResultBanner('', '');

  modalRefs.host.hidden = false;
  document.body.classList.add('modal-open');
  renderModal();

  requestAnimationFrame(() => {
    if (modalRefs.closeBtn) modalRefs.closeBtn.focus();
    else modalRefs.dialog.focus();
  });

  fetchCharacterDetail(name);
}

function openConfigModal() {
  if (!modalRefs.host || !modalRefs.dialog) return;

  modalState.lastFocusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  modalState.activeCharacterName = CONFIG_MODAL_NAME;
  modalState.activeKind = 'config';
  modalState.status = 'loading';
  modalState.detail = null;
  modalState.errorText = '';
  modalState.activeSnapshotUpdatedAtMs = 0;
  modalState.achievementFilter = 'all';
  modalState.achievementTypeFilter = 'all';
  modalState.achievementExpandedSet.clear();
  modalState.achievementSearch = '';
  modalState.configEditorText = '';
  modalState.configIfMatchHash = '';
  modalState.configValidationErrors = [];
  modalState.configBusy = false;
  setConfigResultBanner('', '');

  modalRefs.host.hidden = false;
  document.body.classList.add('modal-open');
  renderModal();

  requestAnimationFrame(() => {
    if (modalRefs.closeBtn) modalRefs.closeBtn.focus();
    else modalRefs.dialog.focus();
  });

  fetchConfigDetail();
}

function openBankModal() {
  if (!modalRefs.host || !modalRefs.dialog) return;

  modalState.lastFocusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  modalState.activeCharacterName = BANK_MODAL_NAME;
  modalState.activeKind = 'bank';
  modalState.status = 'loading';
  modalState.detail = null;
  modalState.errorText = '';
  modalState.activeSnapshotUpdatedAtMs = 0;

  modalRefs.host.hidden = false;
  document.body.classList.add('modal-open');
  renderModal();

  requestAnimationFrame(() => {
    if (modalRefs.closeBtn) modalRefs.closeBtn.focus();
    else modalRefs.dialog.focus();
  });

  fetchBankDetail();
}

function openAchievementsModal() {
  if (!modalRefs.host || !modalRefs.dialog) return;

  modalState.lastFocusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  modalState.activeCharacterName = ACHIEV_MODAL_NAME;
  modalState.activeKind = 'achiev';
  modalState.status = 'loading';
  modalState.detail = null;
  modalState.errorText = '';
  modalState.activeSnapshotUpdatedAtMs = 0;
  modalState.achievementFilter = 'all';
  modalState.achievementTypeFilter = 'all';
  modalState.achievementExpandedSet.clear();
  modalState.achievementSearch = '';

  modalRefs.host.hidden = false;
  document.body.classList.add('modal-open');
  renderModal();

  requestAnimationFrame(() => {
    if (modalRefs.closeBtn) modalRefs.closeBtn.focus();
    else modalRefs.dialog.focus();
  });

  fetchAccountAchievementsDetail();
}

async function fetchBankDetail() {
  if (!isModalOpen() || modalState.activeKind !== 'bank') return;

  abortModalFetch();
  const controller = new AbortController();
  const seq = modalState.fetchSeq + 1;
  modalState.fetchSeq = seq;
  modalState.fetchController = controller;

  try {
    const base = window.__BASE_PATH__ || '';
    const res = await fetch(`${base}/api/ui/bank`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'bank') return;

    modalState.detail = data;
    modalState.status = 'ready';
    modalState.errorText = '';
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!isModalOpen() || modalState.fetchSeq !== seq || modalState.activeKind !== 'bank') return;
    modalState.status = 'error';
    modalState.errorText = safeText(err?.message, 'Failed to fetch bank data');
  } finally {
    if (modalState.fetchController === controller) {
      modalState.fetchController = null;
    }
    renderModal();
  }
}

function closeCharacterModal({ restoreFocus = true } = {}) {
  if (!modalRefs.host || modalRefs.host.hidden) return;

  abortModalFetch();
  modalRefs.host.hidden = true;
  document.body.classList.remove('modal-open');

  const focusEl = modalState.lastFocusedElement;
  modalState.activeCharacterName = '';
  modalState.activeKind = '';
  modalState.status = 'idle';
  modalState.detail = null;
  modalState.errorText = '';
  modalState.activeSnapshotUpdatedAtMs = 0;
  modalState.lastFocusedElement = null;
  modalState.achievementFilter = 'all';
  modalState.achievementTypeFilter = 'all';
  modalState.achievementExpandedSet.clear();
  modalState.achievementSearch = '';
  modalState.configEditorText = '';
  modalState.configIfMatchHash = '';
  modalState.configValidationErrors = [];
  modalState.configBusy = false;
  setConfigResultBanner('', '');

  if (restoreFocus && focusEl && document.contains(focusEl)) {
    focusEl.focus();
  }
}
