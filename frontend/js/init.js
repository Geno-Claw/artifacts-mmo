function applyConfigFeatureVisibility() {
  if (!modalRefs.configBtn) return;
  modalRefs.configBtn.hidden = !runtimeFeatures.configEditorAvailable;
}

function applyRuntimeControlFeatureVisibility() {
  renderControlPanel();
}

async function probeConfigFeatureAvailability() {
  runtimeFeatures.configEditorAvailable = false;
  applyConfigFeatureVisibility();

  try {
    const res = await fetch((window.__BASE_PATH__||'')+'/api/config', { cache: 'no-store' });
    runtimeFeatures.configEditorAvailable = res.status !== 404;
  } catch {
    runtimeFeatures.configEditorAvailable = false;
  }

  applyConfigFeatureVisibility();
}

async function probeControlFeatureAvailability() {
  runtimeFeatures.controlPanelAvailable = false;
  controlState.statusSnapshot = null;
  controlState.statusError = '';
  setControlOperationState('idle');
  setControlResultBanner('', '');
  applyRuntimeControlFeatureVisibility();

  await fetchControlStatus({ silentErrors: true });

  if (runtimeFeatures.controlPanelAvailable) {
    startControlStatusPolling();
  } else {
    stopControlStatusPolling();
  }

  applyRuntimeControlFeatureVisibility();
}

function setupModalFramework() {
  modalRefs.host = document.getElementById('modalHost');
  modalRefs.scrim = document.getElementById('modalScrim');
  modalRefs.dialog = document.getElementById('characterModal');
  modalRefs.kind = document.getElementById('modalKind');
  modalRefs.title = document.getElementById('modalTitle');
  modalRefs.banner = document.getElementById('modalBanner');
  modalRefs.content = document.getElementById('modalContent');
  modalRefs.closeBtn = document.getElementById('modalCloseBtn');
  modalRefs.configBtn = document.getElementById('openConfigBtn');
  controlRefs.restartBtn = document.getElementById('restartBotBtn');
  controlRefs.clearOrderBoardBtn = document.getElementById('clearOrderBoardBtn');
  controlRefs.clearGearStateBtn = document.getElementById('clearGearStateBtn');
  controlRefs.statusPanel = document.getElementById('controlStatusPanel');
  controlRefs.runtimeState = document.getElementById('controlRuntimeState');
  controlRefs.operationState = document.getElementById('controlOperationState');
  controlRefs.updatedAt = document.getElementById('controlStatusUpdatedAt');
  controlRefs.banner = document.getElementById('controlResultBanner');

  bankRefs.panel = document.getElementById('bankStatusPanel');
  bankRefs.goldValue = document.getElementById('bankGoldValue');
  bankRefs.slotsValue = document.getElementById('bankSlotsValue');
  bankRefs.openBtn = document.getElementById('openBankBtn');

  const cardsContainer = document.getElementById('cardsContainer');
  if (cardsContainer) {
    cardsContainer.addEventListener('click', onCardActionClick);
  }
  if (modalRefs.configBtn) {
    modalRefs.configBtn.addEventListener('click', onConfigButtonClick);
  }
  if (bankRefs.openBtn) {
    bankRefs.openBtn.addEventListener('click', () => openBankModal());
  }
  if (controlRefs.restartBtn) {
    controlRefs.restartBtn.addEventListener('click', onRuntimeControlButtonClick);
  }
  if (controlRefs.clearOrderBoardBtn) {
    controlRefs.clearOrderBoardBtn.addEventListener('click', onRuntimeControlButtonClick);
  }
  if (controlRefs.clearGearStateBtn) {
    controlRefs.clearGearStateBtn.addEventListener('click', onRuntimeControlButtonClick);
  }
  if (modalRefs.scrim) {
    modalRefs.scrim.addEventListener('click', () => closeCharacterModal());
  }
  if (modalRefs.closeBtn) {
    modalRefs.closeBtn.addEventListener('click', () => closeCharacterModal());
  }
  if (modalRefs.content) {
    modalRefs.content.addEventListener('click', onModalContentClick);
    modalRefs.content.addEventListener('input', onModalContentInput);
  }
  document.addEventListener('keydown', onDocumentKeydown);
  renderControlPanel();
}

function applySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.characters)) return;
  appState.order = snapshot.characters.map(char => char.name).filter(Boolean);
  appState.characters = new Map(
    snapshot.characters
      .filter(char => !!char?.name)
      .map(char => [char.name, normalizeCharacter(char)])
  );
  appState.orders = (Array.isArray(snapshot.orders) ? snapshot.orders : [])
    .map(normalizeOrderRow)
    .filter(Boolean);
  if (snapshot.bank && typeof snapshot.bank === 'object') {
    const b = snapshot.bank;
    bankState.gold = toNumber(b.gold, bankState.gold);
    bankState.slots = toNumber(b.slots, bankState.slots);
    bankState.usedSlots = toNumber(b.usedSlots, bankState.usedSlots);
    bankState.nextExpansionCost = toNumber(b.nextExpansionCost, bankState.nextExpansionCost);
  }
  renderBankStatusPanel();
  renderOrdersPanel();
  syncCards();
  maybeRefreshActiveModalFromSnapshot();
}

async function loadInitialSnapshot() {
  const base = window.__BASE_PATH__ || '';
  const res = await fetch(`${base}/api/ui/snapshot`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const snapshot = await res.json();
  applySnapshot(snapshot);
}

function connectLiveEvents() {
  if (appState.eventSource) appState.eventSource.close();
  const evtBase = window.__BASE_PATH__ || '';
  appState.eventSource = new EventSource(`${evtBase}/api/ui/events`);

  appState.eventSource.addEventListener('snapshot', (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      applySnapshot(snapshot);
    } catch (err) {
      console.error('Could not parse snapshot event', err);
    }
  });

  appState.eventSource.addEventListener('heartbeat', () => {
    // Connection keepalive marker, no UI action needed.
  });
}

/* ==============================================================
   INIT
   ============================================================== */
async function init() {
  setupModalFramework();
  ordersRefs.panel = document.getElementById('ordersPanel');
  ordersRefs.list = document.getElementById('ordersList');
  ordersRefs.meta = document.getElementById('ordersPanelMeta');
  ordersRefs.filterGroup = document.getElementById('ordersFilterGroup');
  if (ordersRefs.panel) {
    ordersRefs.panel.addEventListener('click', onOrdersPanelClick);
  }
  await Promise.all([
    probeConfigFeatureAvailability(),
    probeControlFeatureAvailability(),
  ]);
  createPetals();

  try {
    await loadInitialSnapshot();
  } catch (err) {
    console.error('Failed to load initial snapshot', err);
  }

  connectLiveEvents();

  setInterval(() => {
    for (const name of appState.order) {
      const char = appState.characters.get(name);
      const refs = cardRefs.get(name);
      if (!char || !refs) continue;
      updateCooldown(refs, char);
    }
  }, 100);
}

window.addEventListener('beforeunload', () => {
  stopControlStatusPolling();
  if (controlState.actionController) {
    controlState.actionController.abort();
    controlState.actionController = null;
  }
  clearControlResetTimer();
  if (appState.eventSource) appState.eventSource.close();
});

document.addEventListener('DOMContentLoaded', init);
