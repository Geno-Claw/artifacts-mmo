/**
 * Per-character state context.
 * Replaces the singleton state.mjs — one instance per character.
 */
import { getCharacter } from './api.mjs';
import { clearGearCache } from './services/gear-loadout.mjs';
import { updateCharacter } from './services/inventory-manager.mjs';
import { recordCharacterSnapshot } from './services/ui-state.mjs';

const DEFAULT_SETTINGS = Object.freeze({
  potions: {
    enabled: true,
    combat: {
      enabled: false,
      refillBelow: 2,
      targetQuantity: 5,
      poisonBias: true,
      respectNonPotionUtility: true,
      monsterTypes: ['elite', 'boss'],
    },
    bankTravel: {
      enabled: false,
      mode: 'smart',
      allowRecall: true,
      allowForestBank: true,
      minSavingsSeconds: 60,
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
    this._applyCharData(this._char);
    return this._char;
  }

  /**
   * Apply character data from an action response immediately, before the
   * cooldown wait.  Avoids stale state during long cooldowns (e.g. bulk
   * crafts).  Most actions return result.character; fight returns
   * result.characters (array).
   */
  applyActionResult(result) {
    if (!result) return;
    const charData = result.character
      ?? result.characters?.find(c => c.name === this.name)
      ?? result.characters?.[0];
    if (!charData) return;
    this._char = charData;
    this._applyCharData(charData);
  }

  /** Shared state-update logic for refresh() and applyActionResult(). */
  _applyCharData(charData) {
    updateCharacter(this.name, charData);
    recordCharacterSnapshot(this.name, charData);

    // Reset all losses and gear cache on level-up so bot retries task monsters
    // and re-evaluates gear (new items may be available at the new level)
    const level = charData.level;
    if (this._lastLevel !== null && level > this._lastLevel) {
      this._losses = {};
      clearGearCache(this.name);
    }
    this._lastLevel = level;
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

  /** Number of unique inventory slots available (grows with bag equipment). */
  inventoryMaxSlots() {
    return (this.get().inventory || []).length;
  }

  /** Number of unique inventory slots currently occupied. */
  inventoryUsedSlots() {
    return (this.get().inventory || []).filter(s => s.code && s.quantity > 0).length;
  }

  /** Number of empty slots available for new item types. */
  inventoryEmptySlots() {
    return Math.max(0, this.inventoryMaxSlots() - this.inventoryUsedSlots());
  }

  inventoryFull() {
    // Full if no empty unique slots OR total quantity hits max_items cap
    if (this.inventoryEmptySlots() <= 0) return true;
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

  /** Remaining cooldown in milliseconds, or 0 if not on cooldown. */
  cooldownRemainingMs() {
    const exp = this._char?.cooldown_expiration;
    if (!exp) return 0;
    const ms = new Date(exp).getTime();
    return Number.isFinite(ms) ? Math.max(0, ms - Date.now()) : 0;
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
    return (this.get().inventory || []).reduce((sum, slot) => {
      if (slot?.code !== 'tasks_coin') return sum;
      return sum + Math.max(0, Number(slot.quantity) || 0);
    }, 0);
  }

  settings() {
    return this._settings;
  }

  updateSettings(settings = {}) {
    this._settings = mergeSettings(settings);
  }
}
