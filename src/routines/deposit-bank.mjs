import { BaseRoutine } from './base.mjs';
import { depositAll } from '../helpers.mjs';
import * as log from '../log.mjs';
import * as geSeller from '../services/ge-seller.mjs';
import * as recycler from '../services/recycler.mjs';
import * as gameData from '../services/game-data.mjs';
import {
  depositGoldToBank,
} from '../services/bank-ops.mjs';
import {
  equipmentCountsOnCharacter,
  getCharacterGearState,
  getOwnedKeepByCodeForInventory,
  publishDesiredOrdersForCharacter,
  refreshGearState,
} from '../services/gear-state.mjs';

export class DepositBankRoutine extends BaseRoutine {
  constructor({
    threshold = 0.8,
    priority = 50,
    sellOnGE = true,
    recycleEquipment = true,
    depositGold = true,
    ...rest
  } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false, ...rest });
    this.threshold = threshold;
    this.sellOnGE = sellOnGE;
    this.recycleEquipment = recycleEquipment;
    this.depositGold = depositGold;
  }

  updateConfig({ threshold, sellOnGE, recycleEquipment, depositGold } = {}) {
    if (threshold !== undefined) this.threshold = threshold;
    if (sellOnGE !== undefined) this.sellOnGE = sellOnGE;
    if (recycleEquipment !== undefined) this.recycleEquipment = recycleEquipment;
    if (depositGold !== undefined) this.depositGold = depositGold;
  }

  canRun(ctx) {
    const cap = ctx.inventoryCapacity();
    if (cap <= 0) return false;

    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (this.threshold <= 0) return depositableCount > 0;
    return (depositableCount / cap) >= this.threshold;
  }

  async execute(ctx) {
    try {
      await refreshGearState();
      publishDesiredOrdersForCharacter(ctx.name);
    } catch (err) {
      log.warn(`[${ctx.name}] Gear-state sync failed: ${err.message}`);
    }
    // Always build keepByCode — uses last known gear state even if refresh failed
    const keepByCode = this._buildKeepByCode(ctx);

    // Step 1: Deposit all non-owned inventory items to bank
    if (this._countDepositableInventory(ctx, keepByCode) > 0) {
      await depositAll(ctx, {
        reason: 'deposit routine keep-owned pass',
        keepByCode,
      });
    }

    // Step 2: Recycle surplus equipment at workshops
    if (this.recycleEquipment && geSeller.getSellRules()) {
      await this._recycleEquipment(ctx);
    }

    // Step 3: Sell items on GE — whitelist only (alwaysSell rules)
    if (this.sellOnGE && geSeller.getSellRules()) {
      await this._sellOnGE(ctx);
    }

    // Step 4: Deposit gold to bank (after GE so listing fees are paid first)
    if (this.depositGold) {
      await this._depositGold(ctx);
    }
  }

  async _recycleEquipment(ctx) {
    try {
      await recycler.executeRecycleFlow(ctx);
    } catch (err) {
      log.error(`[${ctx.name}] Recycle flow error: ${err.message}`);
    }

    // Re-deposit any leftover inventory (failed recycles, etc.)
    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount > 0) {
      log.info(`[${ctx.name}] Re-depositing unrecycled inventory`);
      try {
        await depositAll(ctx, {
          reason: 'deposit routine recycle cleanup',
          keepByCode,
        });
      } catch (err) {
        log.warn(`[${ctx.name}] Could not re-deposit items: ${err.message}`);
      }
    }
  }

  async _depositGold(ctx) {
    const gold = ctx.get().gold;
    if (gold <= 0) return;

    log.info(`[${ctx.name}] Depositing ${gold}g to bank`);
    try {
      await depositGoldToBank(ctx, gold, { reason: 'deposit routine _depositGold' });
    } catch (err) {
      log.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`);
    }
  }

  async _sellOnGE(ctx) {
    try {
      await geSeller.executeSellFlow(ctx);
    } catch (err) {
      log.error(`[${ctx.name}] GE sell flow error: ${err.message}`);
    }

    // Always re-deposit any leftover inventory items + gold
    const keepByCode = this._buildKeepByCode(ctx);
    const depositableCount = this._countDepositableInventory(ctx, keepByCode);
    if (depositableCount > 0) {
      log.info(`[${ctx.name}] Re-depositing unsold inventory`);
      try {
        await depositAll(ctx, {
          reason: 'deposit routine GE cleanup',
          keepByCode,
        });
      } catch (err) {
        log.warn(`[${ctx.name}] Could not re-deposit items: ${err.message}`);
      }
    }

    const gold = ctx.get().gold;
    if (gold > 0) {
      log.info(`[${ctx.name}] Depositing ${gold}g from GE collections`);
      try {
        await depositGoldToBank(ctx, gold, { reason: 'deposit routine GE cleanup gold' });
      } catch (err) {
        log.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`);
      }
    }
  }

  _buildKeepByCode(ctx) {
    const keepByCode = getOwnedKeepByCodeForInventory(ctx);

    const equippedWeapon = `${ctx.get().weapon_slot || ''}`.trim();
    if (equippedWeapon) {
      keepByCode[equippedWeapon] = Math.max(keepByCode[equippedWeapon] || 0, 1);
    }

    // Protect all required gear-state items (combat loadout + tools), quantity-aware.
    const gearState = getCharacterGearState(ctx.name);
    const required = gearState?.required && typeof gearState.required === 'object'
      ? gearState.required
      : {};
    const eqCounts = equipmentCountsOnCharacter(ctx);
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
