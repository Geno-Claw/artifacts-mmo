/**
 * Per-character state context.
 * Replaces the singleton state.mjs — one instance per character.
 */
import { getCharacter } from './api.mjs';
import { clearGearCache } from './helpers.mjs';
import { updateCharacter } from './services/inventory-manager.mjs';

const DEFAULT_SETTINGS = Object.freeze({
  potions: {
    enabled: true,
    combat: {
      enabled: true,
      refillBelow: 5,
      targetQuantity: 20,
      poisonBias: true,
      respectNonPotionUtility: true,
    },
    bankTravel: {
      enabled: true,
      mode: 'smart',
      allowRecall: true,
      allowForestBank: true,
      minSavingsSeconds: 10,
      includeReturnToOrigin: true,
      moveSecondsPerTile: 5,
      itemUseSeconds: 3,
    },
  },
});

function mergeSettings(settings = {}) {
  const potions = settings?.potions || {};
  const combat = potions?.combat || {};
  const bankTravel = potions?.bankTravel || {};

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    potions: {
      ...DEFAULT_SETTINGS.potions,
      ...potions,
      combat: {
        ...DEFAULT_SETTINGS.potions.combat,
        ...combat,
      },
      bankTravel: {
        ...DEFAULT_SETTINGS.potions.bankTravel,
        ...bankTravel,
      },
    },
  };
}

export class CharacterContext {
  constructor(name, settings = {}) {
    this.name = name;
    this._char = null;
    this._losses = {};       // { monsterCode: count }
    this._lastLevel = null;  // for detecting level-ups
    this.craftTarget = null;  // shared craft target for gather/craft routines
    this._settings = mergeSettings(settings);
  }

  async refresh() {
    this._char = await getCharacter(this.name);
    updateCharacter(this.name, this._char);

    // Reset all losses and gear cache on level-up so bot retries task monsters
    // and re-evaluates gear (new items may be available at the new level)
    const level = this._char.level;
    if (this._lastLevel !== null && level > this._lastLevel) {
      this._losses = {};
      clearGearCache(this.name);
    }
    this._lastLevel = level;

    return this._char;
  }

  get() {
    if (!this._char) throw new Error(`State not initialized for ${this.name}`);
    return this._char;
  }

  hpPercent() {
    const c = this.get();
    return (c.hp / c.max_hp) * 100;
  }

  isAt(x, y) {
    const c = this.get();
    return c.x === x && c.y === y;
  }

  hasItem(code, quantity = 1) {
    const slot = this.get().inventory?.find(s => s.code === code);
    return slot ? slot.quantity >= quantity : false;
  }

  itemCount(code) {
    const slot = this.get().inventory?.find(s => s.code === code);
    return slot ? slot.quantity : 0;
  }

  inventoryCount() {
    const inv = this.get().inventory;
    if (!inv) return 0;
    let total = 0;
    for (const slot of inv) {
      if (slot.code) total += slot.quantity;
    }
    return total;
  }

  inventoryCapacity() {
    return this.get().inventory_max_items || 0;
  }

  inventoryFull() {
    const cap = this.inventoryCapacity();
    if (cap === 0) return false;
    return this.inventoryCount() >= cap;
  }

  hasTask() {
    return !!this.get().task;
  }

  taskComplete() {
    const c = this.get();
    return c.task && c.task_progress >= c.task_total;
  }

  skillLevel(skill) {
    return this.get()[`${skill}_level`] || 0;
  }

  equippedItem(slot) {
    return this.get()[`${slot}_slot`] || null;
  }

  // --- Loss tracking ---

  recordLoss(monsterCode) {
    this._losses[monsterCode] = (this._losses[monsterCode] || 0) + 1;
  }

  consecutiveLosses(monsterCode) {
    return this._losses[monsterCode] || 0;
  }

  clearLosses(monsterCode) {
    delete this._losses[monsterCode];
  }

  taskType() {
    return this.get().task_type || null;
  }

  taskCoins() {
    return this.get().tasks_coins || 0;
  }

  settings() {
    return this._settings;
  }
}
