/**
 * Fallback claims algorithm for gear planning.
 *
 * When a character's desired gear isn't fully available, this module fills
 * category-level gaps (e.g. "I need *some* ring") using items the character
 * already has equipped, in inventory, or previously claimed.
 *
 * Pure algorithm — no module-level state.  External lookups are passed
 * via the `deps` parameter.
 */
import { toPositiveInt } from '../utils.mjs';
import {
  equipmentCountsOnCharacter,
  categoryFromItem,
  isToolItem,
} from './equipment-utils.mjs';

const FALLBACK_EQUIPPED_SLOTS = [
  { key: 'weapon_slot', category: 'weapon', quantityKey: null },
  { key: 'shield_slot', category: 'shield', quantityKey: null },
  { key: 'helmet_slot', category: 'helmet', quantityKey: null },
  { key: 'body_armor_slot', category: 'body_armor', quantityKey: null },
  { key: 'leg_armor_slot', category: 'leg_armor', quantityKey: null },
  { key: 'boots_slot', category: 'boots', quantityKey: null },
  { key: 'ring1_slot', category: 'ring', quantityKey: null },
  { key: 'ring2_slot', category: 'ring', quantityKey: null },
  { key: 'amulet_slot', category: 'amulet', quantityKey: null },
  { key: 'bag_slot', category: 'bag', quantityKey: null },
  { key: 'utility1_slot', category: 'utility', quantityKey: 'utility1_slot_quantity' },
  { key: 'utility2_slot', category: 'utility', quantityKey: 'utility2_slot_quantity' },
];

// ── helpers ──────────────────────────────────────────────────────────

function carriedCountForCode(ctx, equipmentCounts, code) {
  return (ctx.itemCount(code) || 0) + (equipmentCounts.get(code) || 0);
}

function fallbackCategoryForCode(ctx, code, deps) {
  if (!ctx || !code) return null;
  const item = deps.getItemFn(code);
  const byType = categoryFromItem(item);
  if (byType) return byType;

  const char = ctx.get();
  for (const slot of FALLBACK_EQUIPPED_SLOTS) {
    if (`${char[slot.key] || ''}`.trim() !== code) continue;
    return slot.category;
  }
  return null;
}

function addFallbackCandidate(candidatesByCategory, category, row) {
  if (!category || !row?.code) return;
  if (!candidatesByCategory.has(category)) candidatesByCategory.set(category, []);
  candidatesByCategory.get(category).push(row);
}

function fallbackPriority(row) {
  const equipped = row?.source === 'equipped';
  const tool = row?.isTool === true;
  if (equipped && !tool) return 0;
  if (!equipped && !tool) return 1;
  if (equipped && tool) return 2;
  return 3;
}

function compareFallbackRows(a, b) {
  const aPriority = fallbackPriority(a);
  const bPriority = fallbackPriority(b);
  if (aPriority !== bPriority) return aPriority - bPriority;
  if (a.level !== b.level) return b.level - a.level;
  const byCode = a.code.localeCompare(b.code);
  if (byCode !== 0) return byCode;
  return `${a.sourceTag || ''}`.localeCompare(`${b.sourceTag || ''}`);
}

function computeMissingByCategory(ctx, desired, deps) {
  const missing = new Map();
  for (const [code, qty] of desired.entries()) {
    const need = toPositiveInt(qty);
    if (!code || need <= 0) continue;
    const category = fallbackCategoryForCode(ctx, code, deps);
    if (!category) continue;
    missing.set(category, (missing.get(category) || 0) + need);
  }
  return missing;
}

// ── main entry point ─────────────────────────────────────────────────

/**
 * Compute fallback claims to fill category-level gaps in a character's
 * desired gear.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} desired — items still needed (code → qty)
 * @param {Map<string, number>} assigned — items already scarcity-assigned
 * @param {Map<string, number>} previousAvailable — previous cycle's available map
 * @param {Map<string, number>|null} sharedAvailability — cross-character shared pool (mutated)
 * @param {object} deps — injectable service functions
 * @param {Function} deps.getItemFn — item lookup
 * @param {Function} deps.globalCountFn — global item count
 * @returns {{ fallbackClaims: Map, missingByCategory: Map, addedByCategory: Map }}
 */
export function computeFallbackClaims(ctx, desired, assigned, previousAvailable = new Map(), sharedAvailability = null, deps) {
  if (!ctx) {
    return {
      fallbackClaims: new Map(),
      missingByCategory: new Map(),
      addedByCategory: new Map(),
    };
  }

  const missingByCategory = computeMissingByCategory(ctx, desired, deps);
  if (missingByCategory.size === 0) {
    return {
      fallbackClaims: new Map(),
      missingByCategory,
      addedByCategory: new Map(),
    };
  }

  const char = ctx.get();
  const eqCounts = equipmentCountsOnCharacter(ctx);
  const candidatesByCategory = new Map();

  // Keep currently-equipped items first so we never discard what the character can wear now.
  for (const slot of FALLBACK_EQUIPPED_SLOTS) {
    const code = `${char[slot.key] || ''}`.trim();
    if (!code || code === 'none') continue;

    const qty = slot.quantityKey
      ? Math.max(1, toPositiveInt(char[slot.quantityKey], 1))
      : 1;
    if (qty <= 0) continue;

    const item = deps.getItemFn(code);
    const category = categoryFromItem(item) || slot.category;
    if (!category) continue;
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'equipped',
      sourceTag: slot.key,
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  // Inventory fallback: only known wearable/utility types.
  for (const slot of char.inventory || []) {
    const code = `${slot?.code || ''}`.trim();
    const qty = toPositiveInt(slot?.quantity);
    if (!code || qty <= 0) continue;

    const item = deps.getItemFn(code);
    const category = categoryFromItem(item);
    if (!category) continue; // Unknown inventory items are not fallback candidates.
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'inventory',
      sourceTag: 'inventory',
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  // Preserve previous-cycle claims that still exist account-wide and are no longer carried.
  for (const [code, rawQty] of previousAvailable.entries()) {
    const prevQty = toPositiveInt(rawQty);
    if (!code || prevQty <= 0) continue;

    const item = deps.getItemFn(code);
    const category = categoryFromItem(item);
    if (!category) continue; // Unknown stale claims are intentionally dropped.
    if ((missingByCategory.get(category) || 0) <= 0) continue;

    const carried = carriedCountForCode(ctx, eqCounts, code);
    const remainingClaim = Math.max(0, prevQty - carried);
    if (remainingClaim <= 0) continue;

    const globalQty = Math.max(0, toPositiveInt(deps.globalCountFn(code), 0));
    const offCharacterQty = Math.max(0, globalQty - carried);
    const qty = Math.min(remainingClaim, offCharacterQty);
    if (qty <= 0) continue;

    addFallbackCandidate(candidatesByCategory, category, {
      code,
      qty,
      source: 'inventory',
      sourceTag: 'previous_available',
      isTool: isToolItem(item),
      level: toPositiveInt(item?.level, 0),
    });
  }

  const extraByCode = new Map();
  const addedByCategory = new Map();
  const categoryRows = [...missingByCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [category, needQty] of categoryRows) {
    let remaining = needQty;
    const rows = [...(candidatesByCategory.get(category) || [])].sort(compareFallbackRows);

    for (const row of rows) {
      if (remaining <= 0) break;

      const alreadyExtra = extraByCode.get(row.code) || 0;
      let roomForCode;
      if (sharedAvailability) {
        if (!sharedAvailability.has(row.code)) {
          sharedAvailability.set(row.code, Math.max(0, toPositiveInt(deps.globalCountFn(row.code), 0)));
        }
        roomForCode = Math.max(0, sharedAvailability.get(row.code) - alreadyExtra);
      } else {
        const assignedQty = assigned.get(row.code) || 0;
        const globalQty = Math.max(0, toPositiveInt(deps.globalCountFn(row.code), 0));
        roomForCode = Math.max(0, globalQty - assignedQty - alreadyExtra);
      }
      if (roomForCode <= 0) continue;

      const takeQty = Math.min(remaining, row.qty, roomForCode);
      if (takeQty <= 0) continue;

      extraByCode.set(row.code, alreadyExtra + takeQty);
      if (sharedAvailability) {
        const cur = sharedAvailability.get(row.code) || 0;
        sharedAvailability.set(row.code, Math.max(0, cur - takeQty));
      }
      remaining -= takeQty;
    }

    const added = needQty - remaining;
    if (added > 0) addedByCategory.set(category, added);
  }

  const fallbackClaims = new Map();
  for (const [code, extraQty] of extraByCode.entries()) {
    const assignedQty = assigned.get(code) || 0;
    const targetQty = assignedQty + extraQty;
    if (targetQty > assignedQty) fallbackClaims.set(code, targetQty);
  }

  return {
    fallbackClaims,
    missingByCategory,
    addedByCategory,
  };
}
