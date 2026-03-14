import { BaseRoutine } from './base.mjs';
import { depositAll } from '../helpers.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as geSeller from '../services/ge-seller.mjs';
import * as npcSeller from '../services/npc-seller.mjs';
import * as pendingItems from '../services/pending-items.mjs';
import * as recycler from '../services/recycler.mjs';
import { shouldPurge, executeBankPurge } from '../services/bank-purge.mjs';
import {
  depositBankItems,
  depositGoldToBank,
} from '../services/bank-ops.mjs';
import {
  equipmentCountsOnCharacter,
  getCharacterGearState,
  getOwnedKeepByCodeForInventory,
  publishDesiredOrdersForCharacter,
  refreshGearState,
} from '../services/gear-state.mjs';

const depositLog = log.createLogger({ scope: 'routine.deposit-bank' });
const CLAIM_PENDING_INVENTORY_CODES = new Set([478, 497]);

const deps = {
  depositAllFn: depositAll,
  depositBankItemsFn: depositBankItems,
  depositGoldToBankFn: depositGoldToBank,
  getSellRulesFn: () => geSeller.getSellRules(),
  executeNpcSellFlowFn: (ctx, opts) => npcSeller.executeNpcSellFlow(ctx, opts),
  executeSellFlowFn: (ctx) => geSeller.executeSellFlow(ctx),
  executeRecycleFlowFn: (ctx) => recycler.executeRecycleFlow(ctx),
  refreshGearStateFn: () => refreshGearState(),
  publishDesiredOrdersForCharacterFn: (charName) => publishDesiredOrdersForCharacter(charName),
  equipmentCountsOnCharacterFn: (ctx) => equipmentCountsOnCharacter(ctx),
  getCharacterGearStateFn: (charName) => getCharacterGearState(charName),
  getOwnedKeepByCodeForInventoryFn: (ctx) => getOwnedKeepByCodeForInventory(ctx),
  pendingItemsSvc: pendingItems,
  claimPendingItemFn: (id, charName) => pendingItems.claimPendingItemForCharacter(id, charName),
  waitForCooldownFn: (result) => api.waitForCooldown(result),
};

export class DepositBankRoutine extends BaseRoutine {
  constructor({
    threshold = 0.8,
    priority = 50,
    sellOnGE = true,
    sellToVendor = true,
    recycleEquipment = true,
    depositGold = true,
    ...rest
  } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false, ...rest });
    this.threshold = threshold;
    this.sellOnGE = sellOnGE;
    this.sellToVendor = sellToVendor;
    this.recycleEquipment = recycleEquipment;
    this.depositGold = depositGold;
  }

  updateConfig({ threshold, sellOnGE, sellToVendor, recycleEquipment, depositGold } = {}) {
    if (threshold !== undefined) this.threshold = threshold;
    if (sellOnGE !== undefined) this.sellOnGE = sellOnGE;
    if (sellToVendor !== undefined) this.sellToVendor = sellToVendor;
    if (recycleEquipment !== undefined) this.recycleEquipment = recycleEquipment;
    if (depositGold !== undefined) this.depositGold = depositGold;
  }

  canRun(ctx) {
    if (deps.pendingItemsSvc.hasClaimableItems()) return true;

    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount <= 0) return false;

    const cap = ctx.inventoryCapacity();
    if (cap <= 0) return false;

    // Always deposit if inventory is full by any metric (unique slots OR total qty cap)
    if (ctx.inventoryEmptySlots() <= 0) return true;
    if (ctx.inventoryFull()) return true;

    if (this.threshold <= 0) return depositableCount > 0;
    return (depositableCount / cap) >= this.threshold;
  }

  async execute(ctx) {
    try {
      await deps.refreshGearStateFn();
      deps.publishDesiredOrdersForCharacterFn(ctx.name);
    } catch (err) {
      depositLog.warn(`[${ctx.name}] Gear-state sync failed: ${err.message}`, {
        event: 'routine.deposit.gear_sync_failed',
        reasonCode: 'gear_state_unavailable',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }
    // Always build keepByCode — uses last known gear state even if refresh failed
    const keepByCode = this._buildKeepByCode(ctx);

    // Step 0: Bank slot pressure relief — free slots before depositing
    if (shouldPurge()) {
      try {
        await executeBankPurge(ctx);
      } catch (err) {
        depositLog.warn(`[${ctx.name}] Bank purge failed: ${err.message}`, {
          event: 'routine.deposit.bank_purge_failed',
          context: { character: ctx.name, routine: this.name },
          error: err,
        });
      }
    }

    // Step 1: Deposit all non-owned inventory items to bank
    if (this._countDepositableInventory(ctx, keepByCode) > 0) {
      await deps.depositAllFn(ctx, {
        reason: 'deposit routine keep-owned pass',
        keepByCode,
      });
    }

    const pendingResult = await this._recoverPendingItems(ctx);
    if (pendingResult?.stopRoutine === true) {
      return;
    }

    // Step 2: Recycle surplus equipment at workshops
    if (this.recycleEquipment && deps.getSellRulesFn()) {
      await this._recycleEquipment(ctx);
    }

    // Step 3: Sell items to NPC vendors when available
    if (this.sellToVendor) {
      await this._sellToVendor(ctx);
    }

    // Step 4: Sell items on GE — duplicate gear plus alwaysSell rules
    if (this.sellOnGE && deps.getSellRulesFn()) {
      await this._sellOnGE(ctx);
    }

    // Step 5: Deposit gold to bank (after GE so listing fees are paid first)
    if (this.depositGold) {
      await this._depositGold(ctx);
    }
  }

  async _sellToVendor(ctx) {
    try {
      await deps.executeNpcSellFlowFn(ctx, {
        sellRules: deps.getSellRulesFn(),
      });
    } catch (err) {
      depositLog.error(`[${ctx.name}] NPC sell flow error: ${err.message}`, {
        event: 'routine.deposit.npc_sell.error',
        reasonCode: 'request_failed',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }

    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount <= 0) return;

    depositLog.info(`[${ctx.name}] Re-depositing unsold vendor inventory`, {
      event: 'routine.deposit.npc_sell.cleanup',
      reasonCode: 'yield_for_deposit',
      context: {
        character: ctx.name,
        routine: this.name,
      },
      data: {
        depositableCount,
      },
    });

    try {
      await deps.depositAllFn(ctx, {
        reason: 'deposit routine vendor cleanup',
        keepByCode,
      });
    } catch (err) {
      depositLog.warn(`[${ctx.name}] Could not re-deposit vendor items: ${err.message}`, {
        event: 'routine.deposit.npc_sell.cleanup_failed',
        reasonCode: 'bank_unavailable',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }
  }

  async _recycleEquipment(ctx) {
    try {
      await deps.executeRecycleFlowFn(ctx);
    } catch (err) {
      depositLog.error(`[${ctx.name}] Recycle flow error: ${err.message}`, {
        event: 'routine.deposit.recycle_error',
        reasonCode: 'recycle_failed',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }

    // Re-deposit any leftover inventory (failed recycles, etc.)
    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount > 0) {
      depositLog.info(`[${ctx.name}] Re-depositing unrecycled inventory`, {
        event: 'routine.deposit.recycle_cleanup',
        reasonCode: 'yield_for_deposit',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        data: {
          depositableCount,
        },
      });
      try {
        await deps.depositAllFn(ctx, {
          reason: 'deposit routine recycle cleanup',
          keepByCode,
        });
      } catch (err) {
        depositLog.warn(`[${ctx.name}] Could not re-deposit items: ${err.message}`, {
          event: 'routine.deposit.recycle_cleanup_failed',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
            routine: this.name,
          },
          error: err,
        });
      }
    }
  }

  async _depositGold(ctx) {
    const gold = ctx.get().gold;
    if (gold <= 0) return;

    depositLog.info(`[${ctx.name}] Depositing ${gold}g to bank`, {
      event: 'routine.deposit.gold.start',
      context: {
        character: ctx.name,
        routine: this.name,
      },
      data: {
        gold,
      },
    });
    try {
      await deps.depositGoldToBankFn(ctx, gold, { reason: 'deposit routine _depositGold' });
    } catch (err) {
      depositLog.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`, {
        event: 'routine.deposit.gold.failed',
        reasonCode: 'bank_unavailable',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }
  }

  async _sellOnGE(ctx) {
    try {
      await deps.executeSellFlowFn(ctx);
    } catch (err) {
      depositLog.error(`[${ctx.name}] GE sell flow error: ${err.message}`, {
        event: 'routine.deposit.ge_sell.error',
        reasonCode: 'request_failed',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        error: err,
      });
    }

    // Always re-deposit any leftover inventory items + gold
    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount > 0) {
      depositLog.info(`[${ctx.name}] Re-depositing unsold inventory`, {
        event: 'routine.deposit.ge_cleanup',
        reasonCode: 'yield_for_deposit',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        data: {
          depositableCount,
        },
      });
      try {
        await deps.depositAllFn(ctx, {
          reason: 'deposit routine GE cleanup',
          keepByCode,
        });
      } catch (err) {
        depositLog.warn(`[${ctx.name}] Could not re-deposit items: ${err.message}`, {
          event: 'routine.deposit.ge_cleanup_failed',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
            routine: this.name,
          },
          error: err,
        });
      }
    }

    const gold = ctx.get().gold;
    if (gold > 0) {
      depositLog.info(`[${ctx.name}] Depositing ${gold}g to bank`, {
        event: 'routine.deposit.gold_cleanup',
        context: {
          character: ctx.name,
          routine: this.name,
        },
        data: {
          gold,
        },
      });
      try {
        await deps.depositGoldToBankFn(ctx, gold, { reason: 'deposit routine gold cleanup' });
      } catch (err) {
        depositLog.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`, {
          event: 'routine.deposit.gold_cleanup_failed',
          reasonCode: 'bank_unavailable',
          context: {
            character: ctx.name,
            routine: this.name,
          },
          error: err,
        });
      }
    }
  }

  async _recoverPendingItems(ctx) {
    return deps.pendingItemsSvc.withClaimLock(ctx, async () => {
      await deps.pendingItemsSvc.refreshPendingItems(true);

      let snapshot = deps.pendingItemsSvc.getPendingItemsSnapshot();
      if (snapshot.length <= 0) return { claimed: 0, stopRoutine: false };

      let claimed = 0;
      for (const entry of snapshot) {
        if (!this._canFitPendingEntry(ctx, entry)) {
          depositLog.info(`[${ctx.name}] Pending items: stopping before claim; next entry will not fit`, {
            event: 'routine.deposit.pending_items.insufficient_space',
            reasonCode: 'inventory_full',
            context: {
              character: ctx.name,
              routine: this.name,
            },
            data: {
              pendingItemId: entry.id,
              source: entry.source || null,
              itemCount: Array.isArray(entry.items) ? entry.items.length : 0,
            },
          });
          break;
        }

        let result;
        try {
          result = await deps.claimPendingItemFn(entry.id, ctx.name);
        } catch (err) {
          if (this._isPendingInventoryError(err)) {
            depositLog.info(`[${ctx.name}] Pending items: claim blocked by inventory space for ${entry.id}`, {
              event: 'routine.deposit.pending_items.claim_blocked',
              reasonCode: 'inventory_full',
              context: {
                character: ctx.name,
                routine: this.name,
              },
              data: {
                pendingItemId: entry.id,
                code: err.code ?? null,
              },
            });
            break;
          }

          if (Number(err?.code) === 404) {
            depositLog.info(`[${ctx.name}] Pending items: stale entry ${entry.id}, refreshing queue`, {
              event: 'routine.deposit.pending_items.stale_entry',
              reasonCode: 'request_failed',
              context: {
                character: ctx.name,
                routine: this.name,
              },
              data: {
                pendingItemId: entry.id,
              },
            });
            deps.pendingItemsSvc.invalidatePendingItems(`claim 404 for ${entry.id}`);
            await deps.pendingItemsSvc.refreshPendingItems(true);
            snapshot = deps.pendingItemsSvc.getPendingItemsSnapshot();
            continue;
          }

          throw err;
        }

        ctx.applyActionResult(result);
        await deps.waitForCooldownFn(result);
        deps.pendingItemsSvc.removePendingItemById(entry.id);
        claimed += 1;

        const claimedRows = this._normalizePendingItemRows(result?.item || entry);
        depositLog.info(`[${ctx.name}] Pending items: claimed ${entry.id}`, {
          event: 'routine.deposit.pending_items.claimed',
          context: {
            character: ctx.name,
            routine: this.name,
          },
          data: {
            pendingItemId: entry.id,
            source: entry.source || null,
            itemRows: claimedRows.length,
            gold: Math.max(0, Number(result?.item?.gold) || 0),
          },
        });

        if (claimedRows.length > 0) {
          try {
            await deps.depositBankItemsFn(ctx, claimedRows, {
              reason: 'deposit routine pending item claim',
            });
          } catch (err) {
            depositLog.warn(`[${ctx.name}] Pending items: claimed ${entry.id} but could not deposit items: ${err.message}`, {
              event: 'routine.deposit.pending_items.deposit_failed',
              reasonCode: 'bank_unavailable',
              context: {
                character: ctx.name,
                routine: this.name,
              },
              error: err,
              data: {
                pendingItemId: entry.id,
                items: claimedRows,
              },
            });
            return { claimed, stopRoutine: true };
          }
        }

        snapshot = deps.pendingItemsSvc.getPendingItemsSnapshot();
      }

      return { claimed, stopRoutine: false };
    });
  }

  _normalizePendingItemRows(entry) {
    const rows = [];
    for (const row of entry?.items || []) {
      const code = row?.code;
      const quantity = Math.max(0, Number(row?.quantity) || 0);
      if (!code || quantity <= 0) continue;
      rows.push({ code, quantity });
    }
    return rows;
  }

  _canFitPendingEntry(ctx, entry) {
    const rows = this._normalizePendingItemRows(entry);
    if (rows.length <= 0) return true;

    let remainingUnits = Math.max(0, ctx.inventoryCapacity() - ctx.inventoryCount());
    if (rows.reduce((sum, row) => sum + row.quantity, 0) > remainingUnits) {
      return false;
    }

    let remainingSlots = Math.max(0, ctx.inventoryEmptySlots());
    const presentCodes = new Set(
      (ctx.get().inventory || [])
        .filter(slot => slot?.code && Number(slot.quantity) > 0)
        .map(slot => slot.code),
    );

    for (const row of rows) {
      if (!presentCodes.has(row.code)) {
        if (remainingSlots <= 0) return false;
        presentCodes.add(row.code);
        remainingSlots -= 1;
      }
      remainingUnits -= row.quantity;
      if (remainingUnits < 0) return false;
    }

    return true;
  }

  _isPendingInventoryError(err) {
    return CLAIM_PENDING_INVENTORY_CODES.has(Number(err?.code));
  }

  _buildKeepByCode(ctx) {
    const keepByCode = deps.getOwnedKeepByCodeForInventoryFn(ctx);

    const equippedWeapon = `${ctx.get().weapon_slot || ''}`.trim();
    if (equippedWeapon) {
      keepByCode[equippedWeapon] = Math.max(keepByCode[equippedWeapon] || 0, 1);
    }

    // Protect items registered by active routines (e.g. combat food)
    const routineKeep = typeof ctx.getRoutineKeepCodes === 'function'
      ? ctx.getRoutineKeepCodes()
      : {};
    for (const [code, qty] of Object.entries(routineKeep)) {
      const n = Math.max(0, Number(qty) || 0);
      if (n > 0) {
        keepByCode[code] = Math.max(keepByCode[code] || 0, n);
      }
    }

    // Protect all required gear-state items (combat loadout + tools), quantity-aware.
    const gearState = deps.getCharacterGearStateFn(ctx.name);
    const required = gearState?.required && typeof gearState.required === 'object'
      ? gearState.required
      : {};
    const eqCounts = deps.equipmentCountsOnCharacterFn(ctx);
    for (const [code, qty] of Object.entries(required)) {
      const need = Math.max(0, Number(qty) || 0);
      if (need <= 0) continue;
      const equipped = eqCounts.get(code) || 0;
      const keepInBags = Math.max(0, need - equipped);
      if (keepInBags > 0) {
        keepByCode[code] = Math.max(keepByCode[code] || 0, keepInBags);
      }
    }

    return keepByCode;
  }

  _countDepositableInventory(ctx, keepByCode = {}) {
    const keepRemainder = new Map();
    for (const [code, qty] of Object.entries(keepByCode || {})) {
      const n = Math.max(0, Number(qty) || 0);
      if (!code || n <= 0) continue;
      keepRemainder.set(code, n);
    }

    let count = 0;
    for (const slot of ctx.get().inventory || []) {
      const code = slot?.code;
      const qty = Math.max(0, Number(slot?.quantity) || 0);
      if (!code || qty <= 0) continue;

      const keep = keepRemainder.get(code) || 0;
      const depositQty = Math.max(0, qty - keep);
      keepRemainder.set(code, Math.max(0, keep - qty));
      count += depositQty;
    }

    return count;
  }
}

export function _setDepsForTests(overrides = {}) {
  Object.assign(deps, overrides);
}

export function _resetDepsForTests() {
  deps.depositAllFn = depositAll;
  deps.depositBankItemsFn = depositBankItems;
  deps.depositGoldToBankFn = depositGoldToBank;
  deps.getSellRulesFn = () => geSeller.getSellRules();
  deps.executeNpcSellFlowFn = (ctx, opts) => npcSeller.executeNpcSellFlow(ctx, opts);
  deps.executeSellFlowFn = (ctx) => geSeller.executeSellFlow(ctx);
  deps.executeRecycleFlowFn = (ctx) => recycler.executeRecycleFlow(ctx);
  deps.refreshGearStateFn = () => refreshGearState();
  deps.publishDesiredOrdersForCharacterFn = (charName) => publishDesiredOrdersForCharacter(charName);
  deps.equipmentCountsOnCharacterFn = (ctx) => equipmentCountsOnCharacter(ctx);
  deps.getCharacterGearStateFn = (charName) => getCharacterGearState(charName);
  deps.getOwnedKeepByCodeForInventoryFn = (ctx) => getOwnedKeepByCodeForInventory(ctx);
  deps.pendingItemsSvc = pendingItems;
  deps.claimPendingItemFn = (id, charName) => pendingItems.claimPendingItemForCharacter(id, charName);
  deps.waitForCooldownFn = (result) => api.waitForCooldown(result);
}
