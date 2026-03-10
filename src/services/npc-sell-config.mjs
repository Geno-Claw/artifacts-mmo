/**
 * NPC sell-list configuration — global config for items to sell to
 * NPC merchants, either at permanent vendors or active NPC events.
 *
 * Loaded from the top-level `npcSellList` in characters.json.
 * Hot-reloaded alongside character config.
 */

let sellList = {};

/**
 * Load/reload the NPC sell list from config.
 * @param {object} config — full config object (has `npcSellList` key)
 */
export function loadNpcSellList(config) {
  const raw = config?.npcSellList;
  if (!raw || typeof raw !== 'object') {
    sellList = {};
    return;
  }

  sellList = {};
  for (const [npcCode, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) continue;
    sellList[npcCode] = items
      .filter(entry => entry && typeof entry.code === 'string' && entry.code.trim())
      .map(entry => ({
        code: entry.code.trim(),
        keepInBank: Math.max(0, Math.floor(Number(entry.keepInBank) || 0)),
      }));
  }
}

/**
 * Returns merged sell-list entries for a given NPC code.
 * Combines NPC-specific entries with `_any` entries.
 * @param {string} npcCode
 * @returns {Array<{ code: string, keepInBank: number }>}
 */
export function getItemsForNpcSell(npcCode) {
  const specific = sellList[npcCode] || [];
  const any = sellList._any || [];
  if (any.length === 0) return specific;
  if (specific.length === 0) return any;

  const seen = new Set(specific.map(entry => entry.code));
  const merged = [...specific];
  for (const entry of any) {
    if (!seen.has(entry.code)) merged.push(entry);
  }
  return merged;
}

/** Returns the full raw sell list (for testing/debugging). */
export function getNpcSellList() {
  return sellList;
}

export function hasNpcSellItem(itemCode) {
  const code = `${itemCode || ''}`.trim();
  if (!code) return false;

  for (const entries of Object.values(sellList)) {
    if (!Array.isArray(entries)) continue;
    if (entries.some(entry => entry?.code === code)) return true;
  }
  return false;
}

// --- Testing helpers ---
export { sellList as _sellList };
