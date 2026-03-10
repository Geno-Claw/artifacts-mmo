import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { bankCount, globalCount, getCharacterToolProfilesSnapshot } from './inventory-manager.mjs';
import { getClaimedTotal, getTrackedCharacterNames } from './gear-state.mjs';
import { getOpenOrderDemandByCode } from './order-board.mjs';
import {
  computeLatestToolBySkill,
  computeToolNeedsByCode,
  computeToolTargetsByCode,
} from './tool-policy.mjs';

const LATEST_TOOL_BANK_RESERVE = 5;

let _deps = {
  gameDataSvc: gameData,
  getClaimedTotalFn: getClaimedTotal,
  getOpenOrderDemandByCodeFn: getOpenOrderDemandByCode,
  globalCountFn: globalCount,
  bankCountFn: bankCount,
  getCharacterToolProfilesSnapshotFn: getCharacterToolProfilesSnapshot,
  getCharacterLevelsSnapshotFn: getCharacterToolProfilesSnapshot,
  getTrackedCharacterNamesFn: getTrackedCharacterNames,
  computeToolNeedsByCodeFn: computeToolNeedsByCode,
  computeLatestToolBySkillFn: computeLatestToolBySkill,
  computeToolTargetsByCodeFn: computeToolTargetsByCode,
};

function hasProfileForCharacter(toolProfilesByChar, name) {
  const charName = `${name || ''}`.trim();
  if (!charName) return false;
  if (toolProfilesByChar instanceof Map) return toolProfilesByChar.has(charName);
  if (toolProfilesByChar && typeof toolProfilesByChar === 'object') {
    return Object.prototype.hasOwnProperty.call(toolProfilesByChar, charName);
  }
  return false;
}

function summarizeMissingCharacters(names = [], limit = 5) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return 'none';
  const head = list.slice(0, limit).join(', ');
  const rest = list.length - Math.min(list.length, limit);
  return rest > 0 ? `${head}, +${rest} more` : head;
}

/**
 * Determine which surplus equipment items can be disposed of from bank contents.
 * Uses the same claim- and order-aware logic for both recycling and GE selling.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems
 * @param {{
 *   sellRules?: object|null,
 *   requireCraftable?: boolean,
 * }} [opts]
 * @returns {Array<{
 *   code: string,
 *   quantity: number,
 *   reason: string,
 *   item: object,
 *   craftSkill: string|null,
 *   isTool: boolean,
 * }>}
 */
export function analyzeSurplusEquipmentCandidates(ctx, bankItems, opts = {}) {
  const sellRules = opts?.sellRules ?? null;
  if (!sellRules?.sellDuplicateEquipment) return [];

  const requireCraftable = opts?.requireCraftable === true;
  const candidates = [];
  const neverSellSet = new Set(sellRules.neverSell || []);
  const levelsByChar = typeof _deps.getCharacterToolProfilesSnapshotFn === 'function'
    ? _deps.getCharacterToolProfilesSnapshotFn()
    : _deps.getCharacterLevelsSnapshotFn?.() || {};
  const trackedNames = _deps.getTrackedCharacterNamesFn();
  const normalizedTracked = Array.isArray(trackedNames)
    ? trackedNames.map(name => `${name || ''}`.trim()).filter(Boolean)
    : [];
  const missingLevelNames = [];
  for (const name of normalizedTracked) {
    if (hasProfileForCharacter(levelsByChar, name)) continue;
    missingLevelNames.push(name);
  }
  const toolSnapshotComplete = normalizedTracked.length > 0 && missingLevelNames.length === 0;
  if (!toolSnapshotComplete) {
    const detail = normalizedTracked.length <= 0
      ? 'no tracked characters'
      : `missing ${missingLevelNames.length}/${normalizedTracked.length} tool profile(s): ${summarizeMissingCharacters(missingLevelNames)}`;
    log.warn(`[${ctx.name}] Surplus equipment: skipping tool disposal analysis (incomplete tool snapshot: ${detail})`);
  }

  const needsByCode = toolSnapshotComplete ? _deps.computeToolNeedsByCodeFn(levelsByChar) : new Map();
  const latestBySkill = toolSnapshotComplete ? _deps.computeLatestToolBySkillFn(levelsByChar) : new Map();
  const targetsByCode = toolSnapshotComplete ? _deps.computeToolTargetsByCodeFn(levelsByChar) : new Map();
  const orderDemandByCode = typeof _deps.getOpenOrderDemandByCodeFn === 'function'
    ? _deps.getOpenOrderDemandByCodeFn()
    : new Map();
  const latestToolCodes = new Set();
  for (const tool of latestBySkill.values()) {
    if (tool?.code) latestToolCodes.add(tool.code);
  }

  for (const [code, bankQty] of bankItems.entries()) {
    if (neverSellSet.has(code)) continue;

    const item = _deps.gameDataSvc.getItem(code);
    if (!item || !_deps.gameDataSvc.isEquipmentType(item)) {
      if (code === 'forest_ring') log.info(`[${ctx.name}] SURPLUS-DEBUG forest_ring SKIPPED: item=${!!item}, isEquip=${item ? _deps.gameDataSvc.isEquipmentType(item) : 'N/A'}, type=${item?.type}`);
      continue;
    }
    if (requireCraftable && !item?.craft?.skill) continue;

    const claimed = _deps.getClaimedTotalFn(code);
    const openOrderDemand = orderDemandByCode.get(code) || 0;
    const totalOwned = _deps.globalCountFn(code);
    const liveBankQty = _deps.bankCountFn(code);
    const isTool = item.type === 'weapon' && item.subtype === 'tool';
    if (isTool && !toolSnapshotComplete) continue;

    let qty = 0;
    let reason = '';

    if (isTool) {
      const needKeep = needsByCode.get(code) || 0;
      const keepTotal = Math.max(claimed + openOrderDemand, needKeep);
      const maxByGlobal = Math.max(0, totalOwned - keepTotal);
      const bankFloor = latestToolCodes.has(code) ? LATEST_TOOL_BANK_RESERVE : 0;
      const maxByBankFloor = bankFloor > 0 ? Math.max(0, liveBankQty - bankFloor) : liveBankQty;
      qty = Math.min(maxByGlobal, maxByBankFloor, liveBankQty);
      const target = targetsByCode.get(code) || needKeep;
      reason = `tool surplus (owned: ${totalOwned}, bank: ${bankQty}, claimed: ${claimed}, open_orders: ${openOrderDemand}, needs: ${needKeep}, target: ${target}, floor: ${bankFloor})`;
    } else {
      const reservedTotal = claimed + openOrderDemand;
      const surplus = totalOwned - reservedTotal;
      qty = Math.min(Math.max(surplus, 0), liveBankQty);
      reason = `unclaimed equipment (owned: ${totalOwned}, bank: ${bankQty}, claimed: ${claimed}, open_orders: ${openOrderDemand})`;
    }

    if (code === 'forest_ring') {
      log.info(`[${ctx.name}] SURPLUS-DEBUG forest_ring: isTool=${isTool}, totalOwned=${totalOwned}, bankQty=${bankQty}, liveBankQty=${liveBankQty}, claimed=${claimed}, openOrderDemand=${openOrderDemand}, qty=${qty}, reason=${reason}`);
    }

    if (qty <= 0) continue;

    candidates.push({
      code,
      quantity: qty,
      reason,
      item,
      craftSkill: item?.craft?.skill || null,
      isTool,
    });
  }

  return candidates;
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  _deps = {
    ..._deps,
    ...input,
  };
}

export function _resetForTests() {
  _deps = {
    gameDataSvc: gameData,
    getClaimedTotalFn: getClaimedTotal,
    getOpenOrderDemandByCodeFn: getOpenOrderDemandByCode,
    globalCountFn: globalCount,
    bankCountFn: bankCount,
    getCharacterToolProfilesSnapshotFn: getCharacterToolProfilesSnapshot,
    getCharacterLevelsSnapshotFn: getCharacterToolProfilesSnapshot,
    getTrackedCharacterNamesFn: getTrackedCharacterNames,
    computeToolNeedsByCodeFn: computeToolNeedsByCode,
    computeLatestToolBySkillFn: computeLatestToolBySkill,
    computeToolTargetsByCodeFn: computeToolTargetsByCode,
  };
}
