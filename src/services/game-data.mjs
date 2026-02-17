/**
 * Game data service — fetches and caches items, monsters, bank contents,
 * and workshop locations from the API. Provides equipment scoring.
 *
 * Data is static per season, so items/monsters are loaded once at startup.
 * Bank items are cached with a short TTL (refreshed on demand).
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { getWeight } from '../data/scoring-weights.mjs';

// --- In-memory caches ---
let itemsCache = null;          // Map<code, item>
let monstersCache = null;       // Map<code, monster>
let resourcesCache = null;      // Map<code, resource>
let dropToResourceCache = null; // Map<itemCode, resourceCode> (reverse lookup)
let resourceLocationCache = {}; // { resourceCode: { x, y } }
let workshopCache = null;       // { skill: { x, y } }
let bankItemsCache = null;      // Map<code, quantity>
let lastBankFetch = 0;
let geLocationCache = null;     // { x, y } or null

const BANK_CACHE_TTL = 60_000; // 1 minute

// --- Initialization ---

export async function initialize() {
  log.info('[GameData] Loading items, monsters, and resources...');
  await Promise.all([loadAllItems(), loadAllMonsters(), loadAllResources(), discoverGELocation()]);

  // Log discovered types to help debug slot-to-type mapping
  const types = new Map();
  for (const item of itemsCache.values()) {
    const key = `${item.type}/${item.subtype || '-'}`;
    types.set(key, (types.get(key) || 0) + 1);
  }
  const typeStr = [...types.entries()].map(([k, v]) => `${k}(${v})`).join(', ');
  log.info(`[GameData] Loaded ${itemsCache.size} items, ${monstersCache.size} monsters, ${resourcesCache.size} resources`);
  log.info(`[GameData] Item types: ${typeStr}`);
}

async function loadAllItems() {
  itemsCache = new Map();
  let page = 1;
  while (true) {
    const result = await api.getItems({ page, size: 100 });
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) break;
    for (const item of items) {
      itemsCache.set(item.code, item);
    }
    if (items.length < 100) break;
    page++;
  }
}

async function loadAllMonsters() {
  monstersCache = new Map();
  let page = 1;
  while (true) {
    const result = await api.getMonsters({ page, size: 100 });
    const monsters = Array.isArray(result) ? result : [];
    if (monsters.length === 0) break;
    for (const m of monsters) {
      monstersCache.set(m.code, m);
    }
    if (monsters.length < 100) break;
    page++;
  }
}

async function loadAllResources() {
  resourcesCache = new Map();
  dropToResourceCache = new Map();
  let page = 1;
  while (true) {
    const result = await api.getResources({ page, size: 100 });
    const resources = Array.isArray(result) ? result : [];
    if (resources.length === 0) break;
    for (const res of resources) {
      resourcesCache.set(res.code, res);
      // Build reverse lookup: item code → resource code
      // When multiple resources drop the same item, prefer the lowest-level one
      for (const drop of res.drops || []) {
        const existing = dropToResourceCache.get(drop.code);
        if (!existing || res.level < resourcesCache.get(existing).level) {
          dropToResourceCache.set(drop.code, res.code);
        }
      }
    }
    if (resources.length < 100) break;
    page++;
  }
}

// --- Query functions ---

export function getItem(code) {
  return itemsCache?.get(code) || null;
}

export function getMonster(code) {
  return monstersCache?.get(code) || null;
}

export function getResource(code) {
  return resourcesCache?.get(code) || null;
}

/**
 * Find which resource drops a given item.
 * Returns the resource object (with code, skill, level, drops), or null.
 */
export function getResourceForDrop(itemCode) {
  const resourceCode = dropToResourceCache?.get(itemCode);
  return resourceCode ? resourcesCache.get(resourceCode) : null;
}

/**
 * Get the map location for a resource. Fetched on first call and cached.
 */
export async function getResourceLocation(resourceCode) {
  if (resourceLocationCache[resourceCode]) return resourceLocationCache[resourceCode];

  const maps = await api.getMaps({ content_type: 'resource', content_code: resourceCode });
  const list = Array.isArray(maps) ? maps : [];
  if (list.length === 0) return null;

  resourceLocationCache[resourceCode] = { x: list[0].x, y: list[0].y };
  return resourceLocationCache[resourceCode];
}

export function findItems({ type, subtype, maxLevel, minLevel, craftSkill } = {}) {
  const results = [];
  for (const item of itemsCache.values()) {
    if (type && item.type !== type) continue;
    if (subtype && item.subtype !== subtype) continue;
    if (maxLevel !== undefined && item.level > maxLevel) continue;
    if (minLevel !== undefined && item.level < minLevel) continue;
    if (craftSkill && item.craft?.skill !== craftSkill) continue;
    results.push(item);
  }
  return results;
}

/**
 * Map slot names to item type/subtype for equipment lookups.
 * The actual API values will be logged at startup — if these mappings
 * don't match, update them based on the logged types.
 */
const SLOT_TO_TYPE = {
  weapon:     [{ type: 'weapon' }],
  shield:     [{ type: 'shield' }],
  helmet:     [{ type: 'helmet' }],
  body_armor: [{ type: 'body_armor' }],
  leg_armor:  [{ type: 'leg_armor' }],
  boots:      [{ type: 'boots' }],
  ring1:      [{ type: 'ring' }],
  ring2:      [{ type: 'ring' }],
  amulet:     [{ type: 'amulet' }],
};

export function getEquipmentForSlot(slot, charLevel) {
  const mappings = SLOT_TO_TYPE[slot];
  if (!mappings) return [];

  // Try each mapping until we find results
  for (const mapping of mappings) {
    const results = findItems({ ...mapping, maxLevel: charLevel });
    if (results.length > 0) return results;
  }
  return [];
}

// --- Equipment scoring ---

/**
 * Score an item for general combat effectiveness.
 * Higher = better. Weights prioritize damage output > survivability.
 */
export function scoreItem(item) {
  if (!item?.effects) return 0;
  let score = 0;
  for (const effect of item.effects) {
    const name = effect.name || effect.code;
    score += (effect.value || 0) * getWeight(name);
  }
  return score;
}

// --- Equipment upgrade finding ---

export const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring1', 'ring2', 'amulet',
];

/**
 * Find the best equipment upgrade a character can craft.
 * @param {CharacterContext} ctx
 * @param {object} opts
 * @param {string} [opts.craftSkill] - Restrict to items crafted with this skill
 * @returns {{ itemCode, slot, recipe, scoreDelta }|null}
 */
export function findBestUpgrade(ctx, { craftSkill } = {}) {
  const char = ctx.get();
  let bestTarget = null;
  let bestScoreDelta = 0;

  for (const slot of EQUIPMENT_SLOTS) {
    const currentCode = char[`${slot}_slot`] || null;
    const currentItem = currentCode ? getItem(currentCode) : null;
    const currentScore = currentItem ? scoreItem(currentItem) : 0;

    const candidates = getEquipmentForSlot(slot, char.level);
    for (const candidate of candidates) {
      if (!candidate.craft) continue;
      if (craftSkill && candidate.craft.skill !== craftSkill) continue;
      if (ctx.hasItem(candidate.code)) continue;

      const score = scoreItem(candidate);
      const delta = score - currentScore;
      if (delta <= bestScoreDelta) continue;

      const skillLevel = ctx.skillLevel(candidate.craft.skill);
      if (skillLevel < candidate.craft.level) continue;

      bestTarget = {
        itemCode: candidate.code,
        slot,
        recipe: candidate.craft,
        scoreDelta: delta,
      };
      bestScoreDelta = delta;
    }
  }

  return bestTarget;
}

// --- Bank items ---

export async function getBankItems(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && bankItemsCache && (now - lastBankFetch) < BANK_CACHE_TTL) {
    return bankItemsCache;
  }

  bankItemsCache = new Map();
  let page = 1;
  while (true) {
    const result = await api.getBankItems({ page, size: 100 });
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) break;
    for (const item of items) {
      const prev = bankItemsCache.get(item.code) || 0;
      bankItemsCache.set(item.code, prev + item.quantity);
    }
    if (items.length < 100) break;
    page++;
  }
  lastBankFetch = now;
  return bankItemsCache;
}

export async function bankHasItem(code, quantity = 1) {
  const bank = await getBankItems();
  return (bank.get(code) || 0) >= quantity;
}

// --- Grand Exchange location ---

async function discoverGELocation() {
  try {
    const maps = await api.getMaps({ content_type: 'grand_exchange' });
    const list = Array.isArray(maps) ? maps : [];
    if (list.length > 0) {
      geLocationCache = { x: list[0].x, y: list[0].y };
      log.info(`[GameData] Grand Exchange at (${geLocationCache.x},${geLocationCache.y})`);
    } else {
      log.warn('[GameData] Grand Exchange location not found');
    }
  } catch (err) {
    log.warn(`[GameData] Could not discover GE location: ${err.message}`);
  }
}

export function getGELocation() {
  return geLocationCache;
}

// --- Equipment type helpers ---

const EQUIPMENT_TYPES = new Set([
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring', 'amulet',
]);

export function isEquipmentType(item) {
  return item != null && EQUIPMENT_TYPES.has(item.type);
}

/**
 * Find equipment upgrades available in bank for a character.
 * Returns array of { slot, itemCode, scoreDelta } sorted by biggest improvement.
 */
export function findBankUpgrades(ctx, bankItems) {
  const char = ctx.get();
  const upgrades = [];

  for (const slot of EQUIPMENT_SLOTS) {
    const currentCode = char[`${slot}_slot`] || null;
    const currentItem = currentCode ? getItem(currentCode) : null;
    const currentScore = currentItem ? scoreItem(currentItem) : 0;

    const candidates = getEquipmentForSlot(slot, char.level);
    let bestItem = null;
    let bestScore = currentScore;

    for (const candidate of candidates) {
      const score = scoreItem(candidate);
      if (score <= bestScore || candidate.code === currentCode) continue;
      if ((bankItems.get(candidate.code) || 0) < 1) continue;
      bestItem = candidate;
      bestScore = score;
    }

    if (bestItem) {
      upgrades.push({ slot, itemCode: bestItem.code, scoreDelta: bestScore - currentScore });
    }
  }

  return upgrades.sort((a, b) => b.scoreDelta - a.scoreDelta);
}

// --- Recipe chain resolution ---

/**
 * Resolve a recipe into an ordered production plan.
 * Each step is one of:
 *   { type: 'gather', itemCode, resource, quantity } — gatherable resource
 *   { type: 'craft', itemCode, recipe, quantity }   — craftable intermediate
 *   { type: 'bank', itemCode, quantity }             — must come from bank (monster drops, etc.)
 *
 * Handles multi-level recipe chains (e.g., copper_dagger needs copper,
 * copper needs copper_ore). Returns steps in dependency order:
 * gather/obtain raw materials first, then craft intermediates.
 *
 * Returns null only for circular dependencies.
 */
export function resolveRecipeChain(recipe) {
  const steps = [];
  const resolving = new Set(); // cycle detection

  function resolve(items, multiplier = 1) {
    for (const mat of items) {
      const needed = mat.quantity * multiplier;

      // 1. Direct resource drop?
      const resource = getResourceForDrop(mat.code);
      if (resource) {
        const existing = steps.find(s => s.itemCode === mat.code && s.type === 'gather');
        if (existing) {
          existing.quantity += needed;
        } else {
          steps.push({ type: 'gather', itemCode: mat.code, resource, quantity: needed });
        }
        continue;
      }

      // 2. Craftable intermediate?
      const item = getItem(mat.code);
      if (item?.craft) {
        if (resolving.has(mat.code)) {
          log.warn(`[GameData] Circular recipe detected for "${mat.code}"`);
          return false;
        }
        resolving.add(mat.code);
        const subRecipe = item.craft;
        const ok = resolve(subRecipe.items, needed);
        resolving.delete(mat.code);
        if (!ok) return false;

        const existing = steps.find(s => s.itemCode === mat.code && s.type === 'craft');
        if (existing) {
          existing.quantity += needed;
        } else {
          steps.push({ type: 'craft', itemCode: mat.code, recipe: subRecipe, quantity: needed });
        }
        continue;
      }

      // 3. Must come from bank (monster drops, event items, etc.)
      const existing = steps.find(s => s.itemCode === mat.code && s.type === 'bank');
      if (existing) {
        existing.quantity += needed;
      } else {
        steps.push({ type: 'bank', itemCode: mat.code, quantity: needed });
      }
    }
    return true;
  }

  return resolve(recipe.items) ? steps : null;
}

// --- Resource / Monster queries ---

/** Find all resources matching a gathering skill, up to a max level. Sorted highest-level first. */
export function findResourcesBySkill(skill, maxLevel) {
  const results = [];
  for (const res of resourcesCache.values()) {
    if (res.skill === skill && res.level <= maxLevel) results.push(res);
  }
  return results.sort((a, b) => b.level - a.level);
}

/** Find all monsters up to a max level. Sorted highest-level first. */
export function findMonstersByLevel(maxLevel) {
  const results = [];
  for (const m of monstersCache.values()) {
    if (m.level <= maxLevel) results.push(m);
  }
  return results.sort((a, b) => b.level - a.level);
}

/** Get the map location for a monster. Fetched on first call and cached. */
const monsterLocationCache = {};
export async function getMonsterLocation(monsterCode) {
  if (monsterLocationCache[monsterCode]) return monsterLocationCache[monsterCode];

  const maps = await api.getMaps({ content_type: 'monster', content_code: monsterCode });
  const list = Array.isArray(maps) ? maps : [];
  if (list.length === 0) return null;

  monsterLocationCache[monsterCode] = { x: list[0].x, y: list[0].y };
  return monsterLocationCache[monsterCode];
}

// --- Workshop locations ---

export async function getWorkshops() {
  if (workshopCache) return workshopCache;
  workshopCache = {};

  // Discover all craft skills from item data
  const skills = new Set();
  for (const item of itemsCache.values()) {
    if (item.craft?.skill) skills.add(item.craft.skill);
  }

  for (const skill of skills) {
    try {
      const maps = await api.getMaps({ content_type: 'workshop', content_code: skill });
      const list = Array.isArray(maps) ? maps : [];
      if (list.length > 0) {
        workshopCache[skill] = { x: list[0].x, y: list[0].y };
      }
    } catch (e) {
      log.warn(`[GameData] Could not find workshop for ${skill}: ${e.message}`);
    }
  }
  log.info(`[GameData] Found ${Object.keys(workshopCache).length} workshops: ${[...Object.keys(workshopCache)].join(', ')}`);
  return workshopCache;
}
