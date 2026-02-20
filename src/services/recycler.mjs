/**
 * Equipment recycling service.
 * Identifies surplus equipment and recycles it at workshops,
 * breaking it down into crafting materials.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { bankCount, globalCount, getCharacterLevelsSnapshot } from './inventory-manager.mjs';
import { getClaimedTotal, getTrackedCharacterNames } from './gear-state.mjs';
import {
  depositBankItems,
  withdrawBankItems,
} from './bank-ops.mjs';
import { getSellRules } from './ge-seller.mjs';
import {
  computeLatestToolBySkill,
  computeToolNeedsByCode,
  computeToolTargetsByCode,
} from './tool-policy.mjs';
import { moveTo } from '../helpers.mjs';
import { toPositiveInt } from '../utils.mjs';

const TARGET_BANK_UNIQUE_SLOTS = 45;
const MAX_RECYCLE_PASSES = 6;
const LATEST_TOOL_BANK_RESERVE = 5;

let _deps = {
  gameDataSvc: gameData,
  getSellRulesFn: getSellRules,
  getClaimedTotalFn: getClaimedTotal,
  globalCountFn: globalCount,
  bankCountFn: bankCount,
  getCharacterLevelsSnapshotFn: getCharacterLevelsSnapshot,
  getTrackedCharacterNamesFn: getTrackedCharacterNames,
  computeToolNeedsByCodeFn: computeToolNeedsByCode,
  computeLatestToolBySkillFn: computeLatestToolBySkill,
  computeToolTargetsByCodeFn: computeToolTargetsByCode,
  withdrawBankItemsFn: withdrawBankItems,
  depositBankItemsFn: depositBankItems,
  moveToFn: moveTo,
  recycleFn: (code, qty, name) => api.recycle(code, qty, name),
  waitForCooldownFn: (result) => api.waitForCooldown(result),
};

function getLevelForCharacter(levelsByChar, name) {
  const charName = `${name || ''}`.trim();
  if (!charName) return 0;
  if (levelsByChar instanceof Map) return toPositiveInt(levelsByChar.get(charName));
  if (levelsByChar && typeof levelsByChar === 'object') {
    return toPositiveInt(levelsByChar[charName]);
  }
  return 0;
}

function summarizeMissingCharacters(names = [], limit = 5) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return 'none';
  const head = list.slice(0, limit).join(', ');
  const rest = list.length - Math.min(list.length, limit);
  return rest > 0 ? `${head}, +${rest} more` : head;
}

// --- Analysis ---

/**
 * Determine which equipment to recycle from bank contents.
 * Only considers equipment with a craft skill (recyclable at a workshop).
 * Respects neverSell and per-character owned item claims.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @param {Map<string, number>} bankItems - code -> quantity
 * @returns {Array<{ code: string, quantity: number, reason: string, craftSkill: string }>}
 */
export function analyzeRecycleCandidates(ctx, bankItems) {
  const sellRules = _deps.getSellRulesFn();
  if (!sellRules?.sellDuplicateEquipment) return [];

  const candidates = [];
  const neverSellSet = new Set(sellRules.neverSell || []);
  const levelsByChar = _deps.getCharacterLevelsSnapshotFn();
  const trackedNames = _deps.getTrackedCharacterNamesFn();
  const normalizedTracked = Array.isArray(trackedNames)
    ? trackedNames.map(name => `${name || ''}`.trim()).filter(Boolean)
    : [];
  const missingLevelNames = [];
  for (const name of normalizedTracked) {
    if (getLevelForCharacter(levelsByChar, name) > 0) continue;
    missingLevelNames.push(name);
  }
  const toolSnapshotComplete = normalizedTracked.length > 0 && missingLevelNames.length === 0;
  if (!toolSnapshotComplete) {
    const detail = normalizedTracked.length <= 0
      ? 'no tracked characters'
      : `missing ${missingLevelNames.length}/${normalizedTracked.length} level(s): ${summarizeMissingCharacters(missingLevelNames)}`;
    log.warn(`[${ctx.name}] Recycle: skipping tool recycle (incomplete level snapshot: ${detail})`);
  }

  const needsByCode = toolSnapshotComplete ? _deps.computeToolNeedsByCodeFn(levelsByChar) : new Map();
  const latestBySkill = toolSnapshotComplete ? _deps.computeLatestToolBySkillFn(levelsByChar) : new Map();
  const targetsByCode = toolSnapshotComplete ? _deps.computeToolTargetsByCodeFn(levelsByChar) : new Map();
  const latestToolCodes = new Set();
  for (const tool of latestBySkill.values()) {
    if (tool?.code) latestToolCodes.add(tool.code);
  }

  for (const [code, bankQty] of bankItems.entries()) {
    if (neverSellSet.has(code)) continue;

    const item = _deps.gameDataSvc.getItem(code);
    if (!item || !_deps.gameDataSvc.isEquipmentType(item)) continue;

    // Must have craft property to be recyclable
    if (!item.craft?.skill) continue;

    const claimed = _deps.getClaimedTotalFn(code);
    const totalOwned = _deps.globalCountFn(code);
    const liveBankQty = _deps.bankCountFn(code);
    const isTool = item.type === 'weapon' && item.subtype === 'tool';
    if (isTool && !toolSnapshotComplete) continue;

    let qty = 0;
    let reason = '';

    if (isTool) {
      const needKeep = needsByCode.get(code) || 0;
      const keepTotal = Math.max(claimed, needKeep);
      const maxByGlobal = Math.max(0, totalOwned - keepTotal);
      const bankFloor = latestToolCodes.has(code) ? LATEST_TOOL_BANK_RESERVE : 0;
      const maxByBankFloor = bankFloor > 0 ? Math.max(0, liveBankQty - bankFloor) : liveBankQty;
      qty = Math.min(maxByGlobal, maxByBankFloor, liveBankQty);
      const target = targetsByCode.get(code) || needKeep;
      reason = `tool surplus (owned: ${totalOwned}, bank: ${bankQty}, claimed: ${claimed}, needs: ${needKeep}, target: ${target}, floor: ${bankFloor})`;
    } else {
      const surplus = totalOwned - claimed;
      qty = Math.min(Math.max(surplus, 0), liveBankQty);
      reason = `unclaimed equipment/jewelry (owned: ${totalOwned}, bank: ${bankQty}, claimed: ${claimed})`;
    }

    if (qty <= 0) continue;

    candidates.push({
      code,
      quantity: qty,
      reason,
      craftSkill: item.craft.skill,
    });
  }

  return candidates;
}

// --- Main recycle flow ---

/**
 * Execute the full recycle flow for a character.
 * Assumes character has already deposited inventory to bank.
 *
 * @param {import('../context.mjs').CharacterContext} ctx
 * @returns {Promise<number>} Number of item types successfully recycled
 */
export async function executeRecycleFlow(ctx) {
  const workshops = await _deps.gameDataSvc.getWorkshops();
  let totalRecycled = 0;

  for (let pass = 1; pass <= MAX_RECYCLE_PASSES; pass++) {
    const bankItems = await _deps.gameDataSvc.getBankItems(true);
    const bankUniqueCount = bankItems.size;
    const pressure = bankUniqueCount > TARGET_BANK_UNIQUE_SLOTS;
    const candidates = analyzeRecycleCandidates(ctx, bankItems);

    if (candidates.length === 0) {
      if (pass === 1) {
        log.info(`[${ctx.name}] Recycle: no unclaimed equipment/jewelry to recycle`);
      }
      break;
    }

    log.info(
      `[${ctx.name}] Recycle pass ${pass}: ${candidates.length} item(s)` +
      ` (bank unique: ${bankUniqueCount}${pressure ? ` > ${TARGET_BANK_UNIQUE_SLOTS}` : ''})`,
    );

    // Group by craft skill for efficient workshop travel
    const groups = new Map();
    for (const candidate of candidates) {
      const skill = candidate.craftSkill;
      if (!workshops[skill]) {
        log.warn(`[${ctx.name}] Recycle: no workshop found for ${skill}, skipping ${candidate.code}`);
        continue;
      }
      if (!groups.has(skill)) groups.set(skill, []);
      groups.get(skill).push(candidate);
    }

    let recycledThisPass = 0;
    for (const [skill, items] of groups) {
      const workshop = workshops[skill];
      recycledThisPass += await _recycleGroup(ctx, skill, workshop, items);
    }
    totalRecycled += recycledThisPass;

    if (!pressure) break;
    if (recycledThisPass <= 0) break;
  }

  log.info(`[${ctx.name}] Recycle: completed, ${totalRecycled} item type(s) recycled`);
  return totalRecycled;
}

// --- Private helpers ---

async function _recycleGroup(ctx, skill, workshop, items) {
  let recycled = 0;

  // Step 1: Withdraw items from bank
  const withdrawResult = await _deps.withdrawBankItemsFn(
    ctx,
    items.map(candidate => ({ code: candidate.code, quantity: candidate.quantity })),
    {
      reason: `recycler withdrawal (${skill})`,
      mode: 'partial',
      retryStaleOnce: true,
    },
  );
  const withdrawn = withdrawResult.withdrawn;
  for (const row of withdrawResult.failed) {
    log.warn(`[${ctx.name}] Recycle: could not withdraw ${row.code}: ${row.error}`);
  }
  for (const row of withdrawResult.skipped) {
    if (!row.reason.startsWith('partial fill')) {
      log.warn(`[${ctx.name}] Recycle: skipped ${row.code} (${row.reason})`);
    }
  }

  if (withdrawn.length === 0) return 0;

  // Step 2: Move to workshop
  await _deps.moveToFn(ctx, workshop.x, workshop.y);

  // Step 3: Recycle each item
  for (const item of withdrawn) {
    const actualQty = ctx.itemCount(item.code);
    if (actualQty <= 0) continue;

    const qty = Math.min(item.quantity, actualQty);

    try {
      log.info(`[${ctx.name}] Recycle: recycling ${item.code} x${qty} at ${skill} workshop`);
      const result = await _deps.recycleFn(item.code, qty, ctx.name);
      await _deps.waitForCooldownFn(result);
      await ctx.refresh();
      recycled++;
      log.info(`[${ctx.name}] Recycle: successfully recycled ${item.code} x${qty}`);
    } catch (err) {
      if (err.code === 473) {
        log.info(`[${ctx.name}] Recycle: ${item.code} cannot be recycled (error 473), will re-deposit`);
      } else {
        log.warn(`[${ctx.name}] Recycle: failed to recycle ${item.code}: ${err.message}`);
      }
    }

    // Check if inventory is getting full from recycled materials
    if (ctx.inventoryCount() >= ctx.inventoryCapacity() * 0.9) {
      log.info(`[${ctx.name}] Recycle: inventory nearly full, depositing materials`);
      await _depositInventory(ctx);
      await _deps.moveToFn(ctx, workshop.x, workshop.y);
    }
  }

  // Step 4: Deposit everything (recycled materials + any failed-to-recycle items)
  await _depositInventory(ctx);

  return recycled;
}

async function _depositInventory(ctx) {
  const items = ctx.get().inventory
    .filter(slot => slot.code)
    .map(slot => ({ code: slot.code, quantity: slot.quantity }));
  if (items.length === 0) return;

  log.info(`[${ctx.name}] Recycle: depositing ${items.length} item(s) to bank`);
  try {
    await _deps.depositBankItemsFn(ctx, items, { reason: 'recycler deposit' });
  } catch (err) {
    log.warn(`[${ctx.name}] Recycle: could not deposit items: ${err.message}`);
  }
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
    getSellRulesFn: getSellRules,
    getClaimedTotalFn: getClaimedTotal,
    globalCountFn: globalCount,
    bankCountFn: bankCount,
    getCharacterLevelsSnapshotFn: getCharacterLevelsSnapshot,
    getTrackedCharacterNamesFn: getTrackedCharacterNames,
    computeToolNeedsByCodeFn: computeToolNeedsByCode,
    computeLatestToolBySkillFn: computeLatestToolBySkill,
    computeToolTargetsByCodeFn: computeToolTargetsByCode,
    withdrawBankItemsFn: withdrawBankItems,
    depositBankItemsFn: depositBankItems,
    moveToFn: moveTo,
    recycleFn: (code, qty, name) => api.recycle(code, qty, name),
    waitForCooldownFn: (result) => api.waitForCooldown(result),
  };
}
