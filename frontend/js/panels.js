function renderBankStatusPanel() {
  if (bankRefs.goldValue) {
    bankRefs.goldValue.textContent = formatGold(bankState.gold);
  }
  if (bankRefs.slotsValue) {
    bankRefs.slotsValue.textContent = `${bankState.usedSlots} / ${bankState.slots}`;
  }
}

function renderOrdersPanel() {
  if (!ordersRefs.panel || !ordersRefs.list || !ordersRefs.meta) return;

  const activeRows = appState.orders
    .filter(order => order.status !== 'fulfilled' && order.remainingQty > 0)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));

  const filter = normalizeOrderFilter(appState.orderFilter, 'all');
  appState.orderFilter = filter;

  ordersRefs.panel.classList.toggle('is-collapsed', filter === 'hidden');
  if (ordersRefs.panel) {
    ordersRefs.panel.querySelectorAll('button[data-order-filter]').forEach((button) => {
      const value = normalizeOrderFilter(button.dataset.orderFilter, '');
      button.classList.toggle('is-active', value === filter);
    });
  }

  if (filter === 'hidden') {
    ordersRefs.meta.textContent = 'Orders hidden';
    ordersRefs.list.innerHTML = '';
    return;
  }

  const visibleRows = filter === 'claimed'
    ? activeRows.filter(row => row.status === 'claimed')
    : activeRows;

  if (filter === 'claimed') {
    ordersRefs.meta.textContent = `${visibleRows.length} claimed`;
  } else {
    ordersRefs.meta.textContent = `${visibleRows.length} active`;
  }

  if (visibleRows.length === 0) {
    ordersRefs.list.innerHTML = filter === 'claimed'
      ? '<div class="orders-empty">No claimed orders right now.</div>'
      : '<div class="orders-empty">No active cross-character orders.</div>';
    return;
  }

  ordersRefs.list.innerHTML = visibleRows.map((row) => {
    const sourceLabel = `${row.sourceType}:${row.sourceCode}`;
    const claimer = row.claimer ? `claimer ${row.claimer}` : 'unclaimed';
    const claimedBadge = row.status === 'claimed'
      ? '<span class="order-claim-badge">CLAIMED</span>'
      : '';
    return `
      <article class=\"order-row\" data-status=\"${escapeHtml(row.status)}\">
        <div class=\"order-item\">
          <div class="order-item-line">
            <span>${escapeHtml(row.itemCode)} · remaining ${escapeHtml(formatNumberish(row.remainingQty, '0'))}</span>
            ${claimedBadge}
          </div>
        </div>
        <div class=\"order-meta\">
          <div>${escapeHtml(sourceLabel)}</div>
          <div>${escapeHtml(claimer)}</div>
        </div>
      </article>
    `;
  }).join('');
}

function setControlResultBanner(tone, text) {
  const normalizedTone = safeText(tone, '').toLowerCase();
  const normalizedText = safeText(text, '');
  if (!normalizedText) {
    controlState.resultBanner = null;
    return;
  }
  controlState.resultBanner = {
    tone: normalizedTone === 'info'
      || normalizedTone === 'success'
      || normalizedTone === 'warning'
      || normalizedTone === 'error'
      ? normalizedTone
      : 'warning',
    text: normalizedText,
  };
}

function clearControlResetTimer() {
  if (!controlState.resetTimer) return;
  clearTimeout(controlState.resetTimer);
  controlState.resetTimer = null;
}

function setControlOperationState(nextState, { action = '' } = {}) {
  const normalizedState = normalizeControlOperationState(nextState, 'idle');
  const nextAction = normalizeControlAction(action, controlState.activeAction);

  controlState.operationState = normalizedState;
  if (normalizedState === 'idle') {
    controlState.activeAction = '';
    clearControlResetTimer();
    return;
  }

  if (nextAction) {
    controlState.activeAction = nextAction;
  }

  clearControlResetTimer();
  if (normalizedState === 'success' || normalizedState === 'failure') {
    const stateAtSchedule = normalizedState;
    controlState.resetTimer = setTimeout(() => {
      if (controlState.operationState !== stateAtSchedule) return;
      controlState.operationState = 'idle';
      controlState.activeAction = '';
      setControlResultBanner('', '');
      renderControlPanel();
    }, 6000);
  }
}

function getControlOperationDisplayValue() {
  const actionLabel = formatUpperToken(getControlActionLabel(controlState.activeAction, ''), '');
  if (controlState.operationState === 'in-flight') {
    return actionLabel ? `IN-FLIGHT - ${actionLabel}` : 'IN-FLIGHT';
  }
  if ((controlState.operationState === 'success' || controlState.operationState === 'failure') && actionLabel) {
    return `${formatUpperToken(controlState.operationState, 'IDLE')} - ${actionLabel}`;
  }
  if (controlState.operationState === 'idle' && controlState.statusSnapshot?.inFlight) {
    const statusAction = formatUpperToken(getControlActionLabel(controlState.statusSnapshot.operationAction, ''), '');
    return statusAction ? `IN-FLIGHT - ${statusAction}` : 'IN-FLIGHT';
  }
  return formatUpperToken(controlState.operationState, 'IDLE');
}

function renderControlPanel() {
  const controlsAvailable = runtimeFeatures.controlPanelAvailable;

  if (controlRefs.restartBtn) {
    controlRefs.restartBtn.hidden = !controlsAvailable;
  }
  if (controlRefs.clearOrderBoardBtn) {
    controlRefs.clearOrderBoardBtn.hidden = !controlsAvailable;
  }
  if (controlRefs.clearGearStateBtn) {
    controlRefs.clearGearStateBtn.hidden = !controlsAvailable;
  }
  if (controlRefs.statusPanel) {
    controlRefs.statusPanel.hidden = !controlsAvailable;
  }

  if (!controlsAvailable) {
    if (controlRefs.restartBtn) controlRefs.restartBtn.disabled = true;
    if (controlRefs.clearOrderBoardBtn) controlRefs.clearOrderBoardBtn.disabled = true;
    if (controlRefs.clearGearStateBtn) controlRefs.clearGearStateBtn.disabled = true;
    if (controlRefs.runtimeState) {
      controlRefs.runtimeState.textContent = '--';
      controlRefs.runtimeState.classList.remove('is-error');
    }
    if (controlRefs.operationState) {
      controlRefs.operationState.textContent = 'IDLE';
      controlRefs.operationState.classList.remove('is-error');
    }
    if (controlRefs.updatedAt) {
      controlRefs.updatedAt.textContent = '--';
      controlRefs.updatedAt.classList.remove('is-error');
    }
    if (controlRefs.banner) {
      controlRefs.banner.hidden = true;
      controlRefs.banner.className = 'dashboard-control-banner';
      controlRefs.banner.textContent = '';
    }
    return;
  }

  const snapshot = controlState.statusSnapshot;
  const serverLocked = !!snapshot?.inFlight;
  const localLocked = controlState.operationState === 'in-flight';
  const controlsLocked = serverLocked || localLocked;

  if (controlRefs.restartBtn) {
    controlRefs.restartBtn.disabled = controlsLocked;
  }
  if (controlRefs.clearOrderBoardBtn) {
    controlRefs.clearOrderBoardBtn.disabled = controlsLocked;
  }
  if (controlRefs.clearGearStateBtn) {
    controlRefs.clearGearStateBtn.disabled = controlsLocked;
  }

  const runtimeValue = formatUpperToken(snapshot?.lifecycle, 'UNKNOWN');
  if (controlRefs.runtimeState) {
    controlRefs.runtimeState.textContent = runtimeValue;
    controlRefs.runtimeState.classList.toggle('is-error', runtimeValue === 'ERROR' || !!controlState.statusError);
  }

  if (controlRefs.operationState) {
    controlRefs.operationState.textContent = getControlOperationDisplayValue();
    controlRefs.operationState.classList.toggle('is-error', controlState.operationState === 'failure');
  }

  if (controlRefs.updatedAt) {
    controlRefs.updatedAt.textContent = formatTime(snapshot?.updatedAtMs);
    controlRefs.updatedAt.classList.toggle('is-error', !!controlState.statusError);
  }

  if (controlRefs.banner) {
    const banner = controlState.resultBanner;
    if (!banner) {
      controlRefs.banner.hidden = true;
      controlRefs.banner.className = 'dashboard-control-banner';
      controlRefs.banner.textContent = '';
    } else {
      controlRefs.banner.hidden = false;
      controlRefs.banner.className = `dashboard-control-banner ${banner.tone}`;
      controlRefs.banner.textContent = banner.text;
    }
  }
}

function stopControlStatusPolling() {
  if (controlState.pollTimer) {
    clearInterval(controlState.pollTimer);
    controlState.pollTimer = null;
  }
  if (controlState.statusController) {
    controlState.statusController.abort();
    controlState.statusController = null;
  }
}

function startControlStatusPolling() {
  stopControlStatusPolling();
  if (!runtimeFeatures.controlPanelAvailable) return;
  controlState.pollTimer = setInterval(() => {
    fetchControlStatus({ silentErrors: true });
  }, CONTROL_STATUS_POLL_MS);
}
