function trapModalFocus(event) {
  if (!isModalOpen() || !modalRefs.dialog) return;
  const focusable = [...modalRefs.dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) {
    event.preventDefault();
    modalRefs.dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = modalRefs.dialog.contains(active);

  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && isSandboxModalOpen()) {
    event.preventDefault();
    closeSandboxModal();
    return;
  }
  if (!isModalOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCharacterModal();
    return;
  }
  if (event.key === 'Tab') {
    trapModalFocus(event);
  }
}

function onCardActionClick(event) {
  const button = closestFromEventTarget(event, 'button[data-modal-kind]');
  if (!button || button.disabled) return;
  const card = button.closest('.card');
  const name = card?.dataset?.charName;
  const kind = safeText(button.dataset.modalKind, '').toLowerCase();
  if (!name || !MODAL_KIND_LABELS[kind]) return;
  openCharacterModal(name, kind);
}

function onConfigButtonClick() {
  if (!runtimeFeatures.configEditorAvailable) return;
  openConfigModal();
}

function onRuntimeControlButtonClick(event) {
  const button = closestFromEventTarget(event, 'button[data-runtime-control]');
  if (!button || button.disabled) return;

  const action = normalizeControlAction(button.dataset.runtimeControl, '');
  if (!action) return;
  runRuntimeControlAction(action);
}

function onOrdersPanelClick(event) {
  const button = closestFromEventTarget(event, 'button[data-order-filter]');
  if (!button || button.disabled || !ordersRefs.panel || !ordersRefs.panel.contains(button)) return;

  const nextFilter = normalizeOrderFilter(button.dataset.orderFilter, appState.orderFilter);
  if (nextFilter === appState.orderFilter) return;

  appState.orderFilter = nextFilter;
  renderOrdersPanel();
}

function onModalContentClick(event) {
  if (!isModalOpen() || modalState.status !== 'ready' || !modalRefs.content) return;

  if (modalState.activeKind === 'achiev') {
    const statusBtn = closestFromEventTarget(event, 'button[data-achievement-filter]');
    if (statusBtn && modalRefs.content.contains(statusBtn)) {
      const nextFilter = safeText(statusBtn.dataset.achievementFilter, '').toLowerCase();
      if (ACHIEVEMENT_FILTER_LABELS[nextFilter] && modalState.achievementFilter !== nextFilter) {
        modalState.achievementFilter = nextFilter;
        renderAchievementsListInPlace();
      }
      return;
    }

    const typeBtn = closestFromEventTarget(event, 'button[data-achievement-type-filter]');
    if (typeBtn && modalRefs.content.contains(typeBtn)) {
      const nextType = safeText(typeBtn.dataset.achievementTypeFilter, '').toLowerCase();
      if (ACHIEVEMENT_TYPE_FILTER_LABELS[nextType] && modalState.achievementTypeFilter !== nextType) {
        modalState.achievementTypeFilter = nextType;
        renderAchievementsListInPlace();
      }
      return;
    }

    const toggleRow = closestFromEventTarget(event, '[data-achievement-toggle]');
    if (toggleRow && modalRefs.content.contains(toggleRow)) {
      const code = safeText(toggleRow.dataset.achievementToggle, '');
      if (!code) return;

      if (modalState.achievementExpandedSet.has(code)) {
        modalState.achievementExpandedSet.delete(code);
      } else {
        modalState.achievementExpandedSet.add(code);
      }

      toggleRow.classList.toggle('is-expanded');
      const detailEl = modalRefs.content.querySelector(
        `[data-achievement-detail="${CSS.escape(code)}"]`
      );
      if (detailEl) {
        detailEl.classList.toggle('is-visible');
      }
      return;
    }
    return;
  }

  if (modalState.activeKind !== 'config') return;
  const button = closestFromEventTarget(event, 'button[data-config-action]');
  if (!button || !modalRefs.content.contains(button) || button.disabled) return;

  const action = safeText(button.dataset.configAction, '').toLowerCase();
  if (action === 'validate') {
    runConfigValidate();
    return;
  }
  if (action === 'save') {
    runConfigSave();
  }
}

function onModalContentInput(event) {
  if (!isModalOpen() || modalState.status !== 'ready' || !modalRefs.content) return;

  if (modalState.activeKind === 'achiev') {
    const input = closestFromEventTarget(event, 'input[data-achievement-search]');
    if (!input || !modalRefs.content.contains(input)) return;

    modalState.achievementSearch = `${input.value ?? ''}`;
    renderAchievementsListInPlace();
    return;
  }

  if (modalState.activeKind !== 'config') return;
  const editor = closestFromEventTarget(event, 'textarea[data-config-json]');
  if (!editor || !modalRefs.content.contains(editor)) return;

  modalState.configEditorText = `${editor.value ?? ''}`;
}

function maybeRefreshActiveModalFromSnapshot() {
  if (!isModalOpen()) return;
  if (modalState.activeKind === 'achiev' || modalState.activeKind === 'config' || modalState.activeKind === 'bank') return;

  const activeChar = appState.characters.get(modalState.activeCharacterName);
  if (!activeChar) {
    renderModal();
    return;
  }

  const nextUpdatedAtMs = Math.max(0, toNumber(activeChar.lastUpdatedAtMs, 0));
  if (nextUpdatedAtMs > 0 && nextUpdatedAtMs !== modalState.activeSnapshotUpdatedAtMs) {
    modalState.activeSnapshotUpdatedAtMs = nextUpdatedAtMs;
    fetchCharacterDetail(modalState.activeCharacterName);
    return;
  }

  renderModal();
}
