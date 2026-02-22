const appState = {
  order: [],
  characters: new Map(),
  orders: [],
  orderFilter: 'all',
};
appState.eventSource = null;

const bankState = {
  gold: 0,
  slots: 0,
  usedSlots: 0,
  nextExpansionCost: 0,
};

const bankRefs = {
  panel: null,
  goldValue: null,
  slotsValue: null,
  openBtn: null,
};

const cardRefs = new Map();
const ordersRefs = {
  panel: null,
  list: null,
  meta: null,
  filterGroup: null,
};

const runtimeFeatures = {
  configEditorAvailable: false,
  controlPanelAvailable: false,
  sandboxAvailable: false,
};

const modalState = {
  activeCharacterName: '',
  activeKind: '',
  status: 'idle', // idle | loading | ready | error
  detail: null,
  errorText: '',
  activeSnapshotUpdatedAtMs: 0,
  fetchController: null,
  fetchSeq: 0,
  lastFocusedElement: null,
  achievementFilter: 'all',
  achievementTypeFilter: 'all',
  achievementExpandedSet: new Set(),
  achievementSearch: '',
  configEditorText: '',
  configIfMatchHash: '',
  configValidationErrors: [],
  configBusy: false,
  configResultBanner: null,
  configActionController: null,
};

const modalRefs = {
  host: null,
  scrim: null,
  dialog: null,
  kind: null,
  title: null,
  banner: null,
  content: null,
  closeBtn: null,
  configBtn: null,
};

const sandboxState = {
  characters: [],
  status: 'idle',
  resultMessage: '',
  resultTone: '',
  resetTimer: null,
};

const sandboxRefs = {
  host: null,
  scrim: null,
  closeBtn: null,
  content: null,
  banner: null,
  openBtn: null,
};

const controlState = {
  operationState: 'idle', // idle | in-flight | success | failure
  activeAction: '',
  statusSnapshot: null,
  statusError: '',
  resultBanner: null,
  actionController: null,
  statusController: null,
  statusSeq: 0,
  pollTimer: null,
  resetTimer: null,
};

const controlRefs = {
  restartBtn: null,
  clearOrderBoardBtn: null,
  clearGearStateBtn: null,
  statusPanel: null,
  runtimeState: null,
  operationState: null,
  updatedAt: null,
  banner: null,
};
