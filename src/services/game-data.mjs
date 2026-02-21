/**
 * Game data service — fetches and caches items, monsters, bank contents,
 * and workshop locations from the API. Provides equipment scoring.
 *
 * Data is static per season, so items/monsters are loaded once at startup.
 * Bank items are delegated to inventory-manager.mjs.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { getWeight } from '../data/scoring-weights.mjs';
import { getBankItems as getInventoryManagerBankItems } from './inventory-manager.mjs';

// --- In-memory caches ---
let itemsCache = null;          // Map<code, item>
let monstersCache = null;       // Map<code, monster>
let resourcesCache = null;      // Map<code, resource>
let dropToResourceCache = null; // Map<itemCode, resourceCode> (reverse lookup)
let dropToMonsterCache = null;  // Map<itemCode, { monster, drop }> (reverse lookup for monster drops)
let resourceLocationCache = {}; // { resourceCode: { x, y } }
let workshopCache = null;       // { skill: { x, y } }
let geLocationCache = null;     // { x, y } or null
let taskRewardsCache = null;    // Array of reward objects
let taskRewardCodes = null;     // Set<itemCode> for fast lookup

// --- Unreachable location tracking (session-scoped) ---
const unreachableLocations = new Set(); // "monster:frost_slime", "resource:iron_rocks"

// --- Initialization ---

export async function initialize() {
  log.info('[GameData] Loading items, monsters, and resources...');
  await Promise.all([loadAllItems(), loadAllMonsters(), loadAllResources(), discoverGELocation(), loadTaskRewards()]);

  // Discover workshops after items are loaded (needs craft skills from item data)
  await getWorkshops();

  // Log discovered types to help debug slot-to-type mapping
  const types = new Map();
  for (const item of itemsCache.values()) {
    const key = `${item.type}/${item.subtype || '-'}`;
    types.set(key, (types.get(key) || 0) + 1);
  }
  const typeStr = [...types.entries()].map(([k, v]) => `${k}(${v})`).join(', ');
  log.info(`[GameData] Loaded ${itemsCache.size} items, ${monstersCache.size} monsters, ${resourcesCache.size} resources`);
  log.info(`[GameData] Item types: ${typeStr}`);

  // Discover transition tiles (informational — logged but not used for navigation yet)
  await discoverTransitionTiles();
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
  dropToMonsterCache = new Map();
  let page = 1;
  while (true) {
    const result = await api.getMonsters({ page, size: 100 });
    const monsters = Array.isArray(result) ? result : [];
    if (monsters.length === 0) break;
    for (const m of monsters) {
      monstersCache.set(m.code, m);
      // Build reverse lookup: item code → lowest-level monster that drops it
      for (const drop of m.drops || []) {
        const existing = dropToMonsterCache.get(drop.code);
        if (!existing || m.level < existing.monster.level) {
          dropToMonsterCache.set(drop.code, { monster: m, drop });
        }
      }
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

async function loadTaskRewards() {
  try {
    const result = await api.getTaskRewards({ size: 100 });
    taskRewardsCache = Array.isArray(result) ? result : [];
    taskRewardCodes = new Set(taskRewardsCache.map(r => r.code));
    log.info(`[GameData] Loaded ${taskRewardsCache.length} task rewards`);
  } catch (err) {
    log.warn(`[GameData] Could not load task rewards: ${err.message}`);
    taskRewardsCache = [];
    taskRewardCodes = new Set();
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
 * Find which monster drops a given item.
 * Returns { monster, drop } where drop has { code, rate, min_quantity, max_quantity }, or null.
 * Prefers the lowest-level monster.
 */
export function getMonsterForDrop(itemCode) {
  return dropToMonsterCache?.get(itemCode) || null;
}

/** Returns true if the item code is obtainable from task coin exchange. */
export function isTaskReward(code) {
  return taskRewardCodes?.has(code) || false;
}

/** Returns the full list of task exchange reward objects. */
export function getTaskRewards() {
  return taskRewardsCache || [];
}

// --- Accessible tile filtering ---

/**
 * Pick the first freely-accessible tile from a list of map tiles.
 * Tiles with non-empty access.conditions (seasonal areas, locked zones) are excluded.
 * Same pattern as bank-ops.mjs isAccessibleBankTile.
 */
function pickAccessibleTile(tiles) {
  for (const t of tiles) {
    const conds = t.access?.conditions;
    if (!Array.isArray(conds) || conds.length === 0) return t;
  }
  return null;
}

/**
 * Mark a location as unreachable (e.g. after receiving error 595).
 * Invalidates the cached location so the next lookup re-fetches and re-filters.
 */
export function markLocationUnreachable(contentType, code) {
  const key = `${contentType}:${code}`;
  unreachableLocations.add(key);
  if (contentType === 'monster') delete monsterLocationCache[code];
  if (contentType === 'resource') delete resourceLocationCache[code];
  log.warn(`[GameData] Marked ${key} as unreachable`);
}

export function isLocationUnreachable(contentType, code) {
  return unreachableLocations.has(`${contentType}:${code}`);
}

/**
 * Get the map location for a resource. Fetched on first call and cached.
 * Filters to accessible tiles only (no access conditions).
 */
export async function getResourceLocation(resourceCode) {
  if (unreachableLocations.has(`resource:${resourceCode}`)) return null;
  if (resourceLocationCache[resourceCode]) return resourceLocationCache[resourceCode];

  const maps = await api.getMaps({ content_type: 'resource', content_code: resourceCode });
  const list = Array.isArray(maps) ? maps : [];
  const tile = pickAccessibleTile(list);
  if (!tile) return null;

  resourceLocationCache[resourceCode] = { x: tile.x, y: tile.y };
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
  bag:        [{ type: 'bag' }],
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

// --- Equipment slots ---

export const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring1', 'ring2', 'amulet', 'bag',
];

// --- Bank items ---

export async function getBankItems(forceRefresh = false) {
  return getInventoryManagerBankItems(forceRefresh);
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

// --- Transition tile discovery ---

let transitionTilesCache = null; // Array of { x, y, layer, name, access }

async function discoverTransitionTiles() {
  try {
    const tiles = [];
    let page = 1;
    while (true) {
      const result = await api.getMaps({ page, size: 100 });
      const maps = Array.isArray(result) ? result : [];
      if (maps.length === 0) break;
      for (const t of maps) {
        if (t.interactions?.transition) {
          tiles.push({
            x: t.x,
            y: t.y,
            layer: t.layer || 'unknown',
            name: t.name || '',
            conditions: t.access?.conditions || [],
            transition: t.interactions.transition,
          });
        }
      }
      if (maps.length < 100) break;
      page++;
    }
    transitionTilesCache = tiles;
    if (tiles.length > 0) {
      const summary = tiles.map(t => `${t.name || '?'} (${t.x},${t.y}) [${t.layer}]`).join(', ');
      log.info(`[GameData] Found ${tiles.length} transition tiles: ${summary}`);
    } else {
      log.info('[GameData] No transition tiles found');
    }
  } catch (err) {
    log.warn(`[GameData] Could not discover transition tiles: ${err.message}`);
    transitionTilesCache = [];
  }
}

export function getTransitionTiles() {
  return transitionTilesCache || [];
}

// --- Equipment type helpers ---

const EQUIPMENT_TYPES = new Set([
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring', 'amulet', 'bag',
]);

export function isEquipmentType(item) {
  return item != null && EQUIPMENT_TYPES.has(item.type);
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

      // 3. Monster drop? → fight step
      const monsterDrop = getMonsterForDrop(mat.code);
      if (monsterDrop) {
        const existing = steps.find(s => s.itemCode === mat.code && s.type === 'fight');
        if (existing) {
          existing.quantity += needed;
        } else {
          steps.push({ type: 'fight', itemCode: mat.code, monster: monsterDrop.monster, drop: monsterDrop.drop, quantity: needed });
        }
        continue;
      }

      // 4. Must come from bank (event items, etc.)
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

/**
 * Check if a character can fulfill all gather steps of a resolved recipe chain.
 * @param {Array} planSteps - from resolveRecipeChain()
 * @param {CharacterContext} ctx
 * @returns {boolean}
 */
export function canFulfillPlan(planSteps, ctx) {
  for (const step of planSteps) {
    if (step.type === 'gather' && step.resource) {
      const charLevel = ctx.skillLevel(step.resource.skill);
      if (charLevel < step.resource.level) return false;
    }
  }
  return true;
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

/**
 * Get the map location for a monster. Fetched on first call and cached.
 * Filters to accessible tiles only (no access conditions).
 */
const monsterLocationCache = {};
export async function getMonsterLocation(monsterCode) {
  if (unreachableLocations.has(`monster:${monsterCode}`)) return null;
  if (monsterLocationCache[monsterCode]) return monsterLocationCache[monsterCode];

  const maps = await api.getMaps({ content_type: 'monster', content_code: monsterCode });
  const list = Array.isArray(maps) ? maps : [];
  const tile = pickAccessibleTile(list);
  if (!tile) return null;

  monsterLocationCache[monsterCode] = { x: tile.x, y: tile.y };
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
