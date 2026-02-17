/**
 * Character state singleton.
 * Call refresh() to pull latest from API. Use get() and convenience accessors everywhere else.
 */
import { getCharacter } from './api.mjs';

let _char = null;

export async function refresh() {
  _char = await getCharacter();
  return _char;
}

export function get() {
  if (!_char) throw new Error('State not initialized — call refresh() first');
  return _char;
}

export function hpPercent() {
  const c = get();
  return (c.hp / c.max_hp) * 100;
}

export function isAt(x, y) {
  const c = get();
  return c.x === x && c.y === y;
}

export function hasItem(code, quantity = 1) {
  const slot = get().inventory?.find(s => s.code === code);
  return slot ? slot.quantity >= quantity : false;
}

export function itemCount(code) {
  const slot = get().inventory?.find(s => s.code === code);
  return slot ? slot.quantity : 0;
}

export function inventoryUsed() {
  return get().inventory?.filter(s => s.code).length || 0;
}

export function inventorySlots() {
  return get().inventory?.length || 0;
}

export function inventoryFull() {
  const inv = get().inventory;
  if (!inv) return false;
  return inv.every(s => s.code);
}

export function hasTask() {
  return !!get().task;
}

export function taskComplete() {
  const c = get();
  return c.task && c.task_progress >= c.task_total;
}

export function skillLevel(skill) {
  return get()[`${skill}_level`] || 0;
}
