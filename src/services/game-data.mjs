/**
 * Game data service — fetches and caches items, monsters, bank contents,
 * and workshop locations from the API.
 *
 * Data is static per season, so items/monsters are loaded once at startup.
 * Bank items are delegated to inventory-manager.mjs.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
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
let npcItemsCache = null;       // Map<npcCode, Array<{code, npc, currency, buy_price, sell_price}>>
let npcBuyableLookup = null;    // Map<npcCode, Set<itemCode>> — quick lookup for buyable items
let npcBuyOfferLookup = null;   // Map<npcCode, Map<itemCode, { code, currency, buyPrice }>>

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

export function getAllResources() {
  return resourcesCache ? [...resourcesCache.values()] : [];
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
 * Find which resource drops a given item, including drop metadata.
 * Returns { resource, drop } where drop has { code, rate, min_quantity, max_quantity }, or null.
 * Mirrors getMonsterForDrop() pattern.
 */
export function getResourceDropInfo(itemCode) {
  const resource = getResourceForDrop(itemCode);
  if (!resource) return null;
  const drop = resource.drops?.find(d => d.code === itemCode);
  return drop ? { resource, drop } : null;
}

/**
 * Find which monster drops a given item.
 * Returns { monster, drop } where drop has { code, rate, min_quantity, max_quantity }, or null.
 * Prefers the lowest-level monster.
 */
export function getMonsterForDrop(itemCode) {
  return dropToMonsterCache?.get(itemCode) || null;
}

/**
 * Estimate how many fights are needed to obtain a given quantity of a drop item.
 * Uses drop rate and avg quantity per drop, with a 1.2x safety margin.
 * Falls back to raw quantity if drop info is unavailable.
 */
export function estimatedFightsForDrops(monsterCode, itemCode, quantity) {
  const monster = monstersCache?.get(monsterCode);
  const drop = monster?.drops?.find(d => d.code === itemCode);
  if (!drop || !drop.rate || drop.rate <= 0) return quantity;

  const avgQtyPerDrop = (drop.min_quantity + drop.max_quantity) / 2;
  const avgPerKill = (drop.rate / 100) * avgQtyPerDrop;
  if (avgPerKill <= 0) return quantity;

  const safetyMargin = 1 + 0.2 * (1 - drop.rate / 100);
  return Math.ceil((quantity / avgPerKill) * safetyMargin);
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
  artifact1:  [{ type: 'artifact' }],
  artifact2:  [{ type: 'artifact' }],
  artifact3:  [{ type: 'artifact' }],
  bag:        [{ type: 'bag' }],
  rune:       [{ type: 'rune' }],
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

// --- Equipment slots ---

export const EQUIPMENT_SLOTS = [
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring1', 'ring2', 'amulet',
  'artifact1', 'artifact2', 'artifact3', 'bag', 'rune',
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

// --- NPC item catalogs ---

/**
 * Load item catalogs for NPC merchants. Called after event-manager init
 * provides the NPC codes from event definitions.
 * @param {string[]} npcCodes — NPC content codes (e.g. 'nomadic_merchant')
 */
export async function loadNpcCatalogs(npcCodes) {
  npcItemsCache = new Map();
  npcBuyableLookup = new Map();
  npcBuyOfferLookup = new Map();

  for (const npcCode of npcCodes) {
    try {
      const items = [];
      let page = 1;
      while (true) {
        const result = await api.getNpcItems(npcCode, { page, size: 100 });
        const batch = Array.isArray(result) ? result : [];
        if (batch.length === 0) break;
        items.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      npcItemsCache.set(npcCode, items);

      const buyable = new Set();
      const offers = new Map();
      for (const item of items) {
        const code = typeof item?.code === 'string' ? item.code.trim() : '';
        const currency = typeof item?.currency === 'string' ? item.currency.trim() : '';
        const buyPriceRaw = Number(item?.buy_price);
        if (!code || !currency || !Number.isFinite(buyPriceRaw) || buyPriceRaw <= 0) continue;

        const buyPrice = Math.floor(buyPriceRaw);
        buyable.add(code);
        offers.set(code, { code, currency, buyPrice });
      }
      npcBuyableLookup.set(npcCode, buyable);
      npcBuyOfferLookup.set(npcCode, offers);

      log.info(`[GameData] NPC ${npcCode}: ${items.length} items (${buyable.size} buyable)`);
    } catch (err) {
      log.warn(`[GameData] Could not load NPC items for ${npcCode}: ${err.message}`);
      npcItemsCache.set(npcCode, []);
      npcBuyableLookup.set(npcCode, new Set());
      npcBuyOfferLookup.set(npcCode, new Map());
    }
  }
}

/** Returns all items a given NPC has with buy_price set (items we can purchase). */
export function getNpcBuyableItems(npcCode) {
  const items = npcItemsCache?.get(npcCode);
  if (!items) return [];
  return items.filter(i => getNpcBuyOffer(npcCode, i.code) != null);
}

/** Returns all items a given NPC has with sell_price set (items we can sell to them). */
export function getNpcSellableItems(npcCode) {
  const items = npcItemsCache?.get(npcCode);
  if (!items) return [];
  return items.filter(i => i.sell_price != null);
}

/** Quick check: does this NPC sell this item? */
export function canNpcSell(npcCode, itemCode) {
  return npcBuyableLookup?.get(npcCode)?.has(itemCode) || false;
}

/** Returns normalized buy-offer metadata for an NPC item, or null if unavailable. */
export function getNpcBuyOffer(npcCode, itemCode) {
  const offer = npcBuyOfferLookup?.get(npcCode)?.get(itemCode);
  if (!offer) return null;
  return { ...offer };
}

/**
 * Find which NPC sells a given item.
 * Returns { npcCode, offer: { code, currency, buyPrice } } or null.
 */
export function findNpcForItem(itemCode) {
  if (!npcBuyOfferLookup) return null;
  for (const [npcCode, offers] of npcBuyOfferLookup) {
    const offer = offers.get(itemCode);
    if (offer) return { npcCode, offer };
  }
  return null;
}

/** Returns the buy price for an item at a given NPC, or null if not buyable. */
export function getNpcBuyPrice(npcCode, itemCode) {
  const offer = getNpcBuyOffer(npcCode, itemCode);
  return offer?.buyPrice ?? null;
}

// --- Equipment type helpers ---

const EQUIPMENT_TYPES = new Set([
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring', 'amulet', 'artifact', 'bag', 'rune',
]);

export function isEquipmentType(item) {
  return item != null && EQUIPMENT_TYPES.has(item.type);
}

/**
 * Resolve a direct NPC-buy acquisition plan for an item quantity.
 * Reuses the generic recipe/material planner so nested NPC currencies can
 * still expand into gather/fight/bank/npc_trade prerequisite steps.
 */
export function resolveNpcBuyPlan(itemCode, quantity = 1) {
  const code = `${itemCode || ''}`.trim();
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (!code || qty <= 0) return null;
  return resolveRecipeChain({
    items: [{ code, quantity: qty }],
  });
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

      // 4. NPC-tradeable item? (subtype === 'npc' or found in NPC catalogs)
      const npcItem = item || getItem(mat.code);
      const npcMatch = findNpcForItem(mat.code);
      if (npcMatch || npcItem?.subtype === 'npc') {
        if (npcMatch) {
          const { npcCode, offer } = npcMatch;
          // Resolve non-gold currencies recursively. Gold is handled later via
          // carried gold + bank gold top-up, not as a bank item dependency.
          if (offer.currency !== 'gold') {
            const currencyNeeded = needed * offer.buyPrice;
            const ok = resolve([{ code: offer.currency, quantity: currencyNeeded }], 1);
            if (!ok) return false;
          }

          const existing = steps.find(s => s.itemCode === mat.code && s.type === 'npc_trade');
          if (existing) {
            existing.quantity += needed;
          } else {
            steps.push({
              type: 'npc_trade',
              itemCode: mat.code,
              npcCode,
              currency: offer.currency,
              buyPrice: offer.buyPrice,
              quantity: needed,
            });
          }
          continue;
        }
        // subtype is 'npc' but not found in any loaded NPC catalog — fall through to bank
      }

      // 5. Must come from bank (event items, etc.)
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

/**
 * Bank-aware plan fulfillment check. For gather steps, skips the skill check
 * when bank+inventory already covers the requirement. Also checks intermediate
 * craft skill levels (which canFulfillPlan does not).
 *
 * @param {Array} planSteps - from resolveRecipeChain()
 * @param {CharacterContext} ctx
 * @param {Map} bankItems - Map<itemCode, quantity>
 * @returns {{ ok: boolean, deficits: Array }} deficits = steps that can't be fulfilled
 */
export function canFulfillPlanWithBank(planSteps, ctx, bankItems) {
  const bank = bankItems instanceof Map ? bankItems : new Map();
  const deficits = [];

  for (const step of planSteps) {
    if (step.type === 'gather' && step.resource) {
      if (ctx.skillLevel(step.resource.skill) >= step.resource.level) continue;
      // Can't gather — check if bank+inventory covers the requirement
      const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
      if (have >= step.quantity) continue;
      deficits.push(step);
    }
    if (step.type === 'craft' && step.recipe) {
      if (ctx.skillLevel(step.recipe.skill) >= step.recipe.level) continue;
      deficits.push(step);
    }
  }

  return { ok: deficits.length === 0, deficits };
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

// Test helpers.
export function _setCachesForTests({
  items = null,
  monsters = null,
  resources = null,
  npcBuyOffers = null,
} = {}) {
  if (items !== null) {
    itemsCache = new Map(items);
  }

  if (monsters !== null) {
    monstersCache = new Map(monsters);
    dropToMonsterCache = new Map();
    for (const monster of monstersCache.values()) {
      for (const drop of monster?.drops || []) {
        const existing = dropToMonsterCache.get(drop.code);
        if (!existing || (Number(monster.level) || 0) < (Number(existing.monster?.level) || 0)) {
          dropToMonsterCache.set(drop.code, { monster, drop });
        }
      }
    }
  }

  if (resources !== null) {
    resourcesCache = new Map(resources);
    dropToResourceCache = new Map();
    for (const resource of resourcesCache.values()) {
      for (const drop of resource?.drops || []) {
        const existingCode = dropToResourceCache.get(drop.code);
        const existingLevel = existingCode ? (Number(resourcesCache.get(existingCode)?.level) || 0) : Number.POSITIVE_INFINITY;
        const resourceLevel = Number(resource?.level) || 0;
        if (!existingCode || resourceLevel < existingLevel) {
          dropToResourceCache.set(drop.code, resource.code);
        }
      }
    }
  }

  if (npcBuyOffers !== null) {
    npcBuyOfferLookup = new Map();
    for (const [npcCode, offers] of npcBuyOffers) {
      npcBuyOfferLookup.set(npcCode, new Map(offers));
    }
  }
}

export function _resetForTests() {
  itemsCache = null;
  monstersCache = null;
  resourcesCache = null;
  dropToResourceCache = null;
  dropToMonsterCache = null;
  resourceLocationCache = {};
  workshopCache = null;
  geLocationCache = null;
  taskRewardsCache = null;
  taskRewardCodes = null;
  npcItemsCache = null;
  npcBuyableLookup = null;
  npcBuyOfferLookup = null;
  unreachableLocations.clear();
  for (const key of Object.keys(monsterLocationCache)) {
    delete monsterLocationCache[key];
  }
}
