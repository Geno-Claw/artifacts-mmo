/**
 * Equipment recycling service.
 * Identifies surplus equipment and recycles it at workshops,
 * breaking it down into crafting materials.
 */
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import {
  depositAllInventory,
  withdrawBankItems,
} from './bank-ops.mjs';
import { getSellRules } from './ge-seller.mjs';
import {
  analyzeSurplusEquipmentCandidates,
  _resetForTests as _resetSurplusDepsForTests,
  _setDepsForTests as _setSurplusDepsForTests,
} from './equipment-surplus.mjs';
import { moveTo } from '../helpers.mjs';

const TARGET_BANK_UNIQUE_SLOTS = 45;
const MAX_RECYCLE_PASSES = 6;

let _deps = {
  gameDataSvc: gameData,
  getSellRulesFn: getSellRules,
  withdrawBankItemsFn: withdrawBankItems,
  depositAllInventoryFn: depositAllInventory,
  moveToFn: moveTo,
  recycleFn: (code, qty, name) => api.recycle(code, qty, name),
  waitForCooldownFn: (result) => api.waitForCooldown(result),
};

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
  return analyzeSurplusEquipmentCandidates(ctx, bankItems, {
    sellRules: _deps.getSellRulesFn(),
    requireCraftable: true,
  }).map(candidate => ({
    code: candidate.code,
    quantity: candidate.quantity,
    reason: candidate.reason,
    craftSkill: candidate.craftSkill,
  }));
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

    // Pre-emptive deposit if inventory is nearly full before attempting recycle
    if (ctx.inventoryCount() >= ctx.inventoryCapacity() * 0.8) {
      log.info(`[${ctx.name}] Recycle: inventory at ${ctx.inventoryCount()}/${ctx.inventoryCapacity()}, depositing before next recycle`);
      await _depositInventory(ctx);
      await _deps.moveToFn(ctx, workshop.x, workshop.y);
    }

    try {
      log.info(`[${ctx.name}] Recycle: recycling ${item.code} x${qty} at ${skill} workshop`);
      const result = await _deps.recycleFn(item.code, qty, ctx.name);
      ctx.applyActionResult(result);
      await _deps.waitForCooldownFn(result);
      recycled++;
      log.info(`[${ctx.name}] Recycle: successfully recycled ${item.code} x${qty}`);
    } catch (err) {
      if (err.code === 473) {
        log.info(`[${ctx.name}] Recycle: ${item.code} cannot be recycled (error 473), will re-deposit`);
      } else if (err.message?.includes('inventory is full') || err.code === 497) {
        // Inventory full — deposit materials and retry once
        log.info(`[${ctx.name}] Recycle: inventory full, depositing and retrying ${item.code} x${qty}`);
        await _depositInventory(ctx);
        await _deps.moveToFn(ctx, workshop.x, workshop.y);
        try {
          const retryQty = Math.min(qty, ctx.itemCount(item.code));
          if (retryQty > 0) {
            const result = await _deps.recycleFn(item.code, retryQty, ctx.name);
            ctx.applyActionResult(result);
            await _deps.waitForCooldownFn(result);
            recycled++;
            log.info(`[${ctx.name}] Recycle: successfully recycled ${item.code} x${retryQty} (retry)`);
          }
        } catch (retryErr) {
          log.warn(`[${ctx.name}] Recycle: retry failed for ${item.code}: ${retryErr.message}`);
        }
      } else {
        log.warn(`[${ctx.name}] Recycle: failed to recycle ${item.code}: ${err.message}`);
      }
    }

    // Post-recycle deposit if inventory is getting full from recycled materials
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
  try {
    const count = (ctx.get().inventory || []).filter(slot => slot?.code).length;
    if (count > 0) {
      log.info(`[${ctx.name}] Recycle: depositing inventory to bank`);
    }
    await _deps.depositAllInventoryFn(ctx, {
      reason: 'recycler deposit',
      keepByCode: typeof ctx.getRoutineKeepCodes === 'function'
        ? (ctx.getRoutineKeepCodes() || {})
        : {},
    });
  } catch (err) {
    log.warn(`[${ctx.name}] Recycle: could not deposit items: ${err.message}`);
  }
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  const shared = {};
  for (const key of [
    'gameDataSvc',
    'getClaimedTotalFn',
    'getOpenOrderDemandByCodeFn',
    'globalCountFn',
    'bankCountFn',
    'getCharacterToolProfilesSnapshotFn',
    'getCharacterLevelsSnapshotFn',
    'getTrackedCharacterNamesFn',
    'computeToolNeedsByCodeFn',
    'computeLatestToolBySkillFn',
    'computeToolTargetsByCodeFn',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    shared[key] = input[key];
    delete input[key];
  }
  if (Object.keys(shared).length > 0) {
    _setSurplusDepsForTests(shared);
  }
  if (Object.prototype.hasOwnProperty.call(shared, 'gameDataSvc')) {
    input.gameDataSvc = shared.gameDataSvc;
  }
  _deps = {
    ..._deps,
    ...input,
  };
}

export function _resetForTests() {
  _resetSurplusDepsForTests();
  _deps = {
    gameDataSvc: gameData,
    getSellRulesFn: getSellRules,
    withdrawBankItemsFn: withdrawBankItems,
    depositAllInventoryFn: depositAllInventory,
    moveToFn: moveTo,
    recycleFn: (code, qty, name) => api.recycle(code, qty, name),
    waitForCooldownFn: (result) => api.waitForCooldown(result),
  };
}
