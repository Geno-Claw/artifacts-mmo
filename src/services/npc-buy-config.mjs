/**
 * NPC buy-list configuration — global config for items to purchase from
 * NPC merchants during events.
 *
 * Loaded from the top-level `npcBuyList` in characters.json.
 * Hot-reloaded alongside character config.
 */

let buyList = {};

/**
 * Load/reload the NPC buy list from config.
 * @param {object} config — full config object (has `npcBuyList` key)
 */
export function loadNpcBuyList(config) {
  const raw = config?.npcBuyList;
  if (!raw || typeof raw !== 'object') {
    buyList = {};
    return;
  }

  buyList = {};
  for (const [npcCode, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) continue;
    buyList[npcCode] = items
      .filter(e => e && typeof e.code === 'string' && e.code.trim())
      .map(e => ({
        code: e.code.trim(),
        maxTotal: Math.max(1, Math.floor(Number(e.maxTotal) || 1)),
      }));
  }
}

/**
 * Returns merged buy-list entries for a given NPC code.
 * Combines NPC-specific entries with `_any` entries.
 * @param {string} npcCode
 * @returns {Array<{code: string, maxTotal: number}>}
 */
export function getItemsForNpc(npcCode) {
  const specific = buyList[npcCode] || [];
  const any = buyList['_any'] || [];
  if (any.length === 0) return specific;
  if (specific.length === 0) return any;

  // Merge: specific items take priority (by code), then append _any items not already listed
  const seen = new Set(specific.map(e => e.code));
  const merged = [...specific];
  for (const entry of any) {
    if (!seen.has(entry.code)) merged.push(entry);
  }
  return merged;
}

/** Returns the full raw buy list (for testing/debugging). */
export function getNpcBuyList() {
  return buyList;
}

// --- Testing helpers ---
export { buyList as _buyList };
