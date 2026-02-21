const PLACEHOLDER_LOG = 'OFFLINE — waiting for runtime updates';

const LOG_TYPE_ICONS = {
  movement:       'explore',
  fight:          'swords',
  gathering:      'landscape',
  crafting:       'construction',
  rest:           'bedtime',
  use:            'auto_awesome',
  equip:          'shield',
  unequip:        'backpack',
  deposit_item:   'account_balance',
  deposit_gold:   'savings',
  withdraw_item:  'output',
  withdraw_gold:  'savings',
  sell:           'sell',
  buy:            'shopping_cart',
  recycling:      'recycling',
  task:           'assignment',
  delete:         'delete',
  _default:       'help',
};

function logTypeIcon(type) {
  const name = LOG_TYPE_ICONS[type] || LOG_TYPE_ICONS._default;
  return `<span class="log-icon">${name}</span>`;
}

const CONFIG_MODAL_NAME = '__config__';
const BANK_MODAL_NAME = '__bank__';
const MODAL_KIND_LABELS = {
  skills: 'Skills',
  inven: 'Inventory',
  equip: 'Equipment',
  stats: 'Stats',
  achiev: 'Achievements',
  config: 'Config',
  bank: 'Bank',
};
const ACHIEVEMENT_FILTER_LABELS = {
  all: 'All',
  completed: 'Completed',
  'in-progress': 'In Progress',
  'not-started': 'Not Started',
};
const ACHIEVEMENT_TYPE_FILTER_MAP = {
  all: null,
  combat: ['combat_kill', 'combat_level', 'combat_drop'],
  gathering: ['gathering'],
  crafting: ['crafting', 'recycling'],
  tasks: ['task'],
  trading: ['npc_sell', 'npc_buy'],
  use: ['use'],
};
const ACHIEVEMENT_TYPE_FILTER_LABELS = {
  all: 'All Types',
  combat: 'Combat',
  gathering: 'Gathering',
  crafting: 'Crafting',
  tasks: 'Tasks',
  trading: 'Trading',
  use: 'Use',
};
const ORDER_FILTER_LABELS = {
  all: 'All Orders',
  claimed: 'Claimed Orders',
  hidden: 'Hide All Orders',
};
const CONTROL_ACTION_LABELS = {
  reload: 'Reload Config',
  restart: 'Restart Bot',
  'clear-order-board': 'Clear Order Board',
  'clear-gear-state': 'Clear Gear State',
};
const CONTROL_ACTION_ENDPOINTS = {
  get reload() { return (window.__BASE_PATH__||'')+'/api/control/reload-config'; },
  get restart() { return (window.__BASE_PATH__||'')+'/api/control/restart'; },
  get 'clear-order-board'() { return (window.__BASE_PATH__||'')+'/api/control/clear-order-board'; },
  get 'clear-gear-state'() { return (window.__BASE_PATH__||'')+'/api/control/clear-gear-state'; },
};
const CONTROL_OPERATION_STATE_VALUES = new Set(['idle', 'in-flight', 'success', 'failure']);
const CONTROL_STATUS_POLL_MS = 5000;
const CONTROL_ACTION_REQUEST_TIMEOUT_MS = 30_000;
