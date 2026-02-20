/**
 * Pure utility functions for equipment classification and counting.
 * No side effects, no module-level state — safe to import anywhere.
 */
import { toPositiveInt } from '../utils.mjs';
import { EQUIPMENT_SLOTS } from './game-data.mjs';

const OWNED_EQUIPMENT_SLOTS = [...new Set([...EQUIPMENT_SLOTS, 'bag'])];
const UTILITY_SLOTS = ['utility1_slot', 'utility2_slot'];

/**
 * Convert a Map<string, number> to a sorted plain object, filtering out zero/negative entries.
 */
export function mapToObject(map) {
  const entries = [...map.entries()].filter(([, qty]) => qty > 0);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

/**
 * Count all items a character has equipped (equipment slots + utility slots with quantities).
 * Returns Map<itemCode, totalQty>.
 */
export function equipmentCountsOnCharacter(ctx) {
  const char = ctx.get();
  const counts = new Map();
  for (const slot of OWNED_EQUIPMENT_SLOTS) {
    const code = char[`${slot}_slot`] || null;
    if (!code || code === 'none') continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  for (const slot of UTILITY_SLOTS) {
    const code = char[slot] || null;
    if (!code || code === 'none') continue;
    const qty = Math.max(1, toPositiveInt(char[`${slot}_quantity`], 1));
    counts.set(code, (counts.get(code) || 0) + qty);
  }
  return counts;
}

/**
 * Classify an item into a gear category based on its type/subtype.
 * Returns null for unrecognised types.
 */
export function categoryFromItem(item) {
  const type = `${item?.type || ''}`.trim();
  if (!type) return null;
  if (type === 'weapon') {
    return item?.subtype === 'tool' ? 'tool' : 'weapon';
  }
  if (type === 'shield') return 'shield';
  if (type === 'helmet') return 'helmet';
  if (type === 'body_armor') return 'body_armor';
  if (type === 'leg_armor') return 'leg_armor';
  if (type === 'boots') return 'boots';
  if (type === 'ring') return 'ring';
  if (type === 'amulet') return 'amulet';
  if (type === 'bag') return 'bag';
  if (type === 'utility') return 'utility';
  return null;
}

/**
 * Check if an item definition represents a gathering tool.
 */
export function isToolItem(item) {
  return item?.type === 'weapon' && item?.subtype === 'tool';
}
