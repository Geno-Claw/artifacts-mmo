/**
 * Per-character state context.
 * Replaces the singleton state.mjs — one instance per character.
 */
import { getCharacter } from './api.mjs';

export class CharacterContext {
  constructor(name) {
    this.name = name;
    this._char = null;
  }

  async refresh() {
    this._char = await getCharacter(this.name);
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

  inventoryUsed() {
    return this.get().inventory?.filter(s => s.code).length || 0;
  }

  inventorySlots() {
    return this.get().inventory?.length || 0;
  }

  inventoryFull() {
    const inv = this.get().inventory;
    if (!inv) return false;
    return inv.every(s => s.code);
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
}
