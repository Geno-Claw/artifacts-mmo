/**
 * Per-character state context.
 * Replaces the singleton state.mjs — one instance per character.
 */
import { getCharacter } from './api.mjs';
import { clearGearCache } from './helpers.mjs';

export class CharacterContext {
  constructor(name) {
    this.name = name;
    this._char = null;
    this._losses = {};       // { monsterCode: count }
    this._lastLevel = null;  // for detecting level-ups
    this.craftTarget = null;  // shared craft target for gather/craft tasks
  }

  async refresh() {
    this._char = await getCharacter(this.name);

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
}
