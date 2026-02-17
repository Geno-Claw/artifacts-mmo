import { BaseTask } from './base.mjs';
import { depositAll, moveTo, swapEquipment } from '../helpers.mjs';
import { BANK } from '../data/locations.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import * as geSeller from '../services/ge-seller.mjs';

export class DepositBankTask extends BaseTask {
  constructor({
    threshold = 0.8,
    priority = 50,
    sellOnGE = true,
    depositGold = true,
    autoEquipOnBank = true,
  } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false });
    this.threshold = threshold;
    this.sellOnGE = sellOnGE;
    this.depositGold = depositGold;
    this.autoEquipOnBank = autoEquipOnBank;
  }

  canRun(ctx) {
    const count = ctx.inventoryCount();
    const cap = ctx.inventoryCapacity();
    return cap > 0 && (count / cap) >= this.threshold;
  }

  async execute(ctx) {
    // Step 1: Deposit all inventory items to bank
    await depositAll(ctx);

    // Step 2: Deposit gold to bank
    if (this.depositGold) {
      await this._depositGold(ctx);
    }

    // Step 3: Auto-equip from bank (before selling so we don't sell upgrades)
    if (this.autoEquipOnBank) {
      await this._autoEquipFromBank(ctx);
    }

    // Step 4: Sell items on GE
    if (this.sellOnGE && geSeller.getSellRules()) {
      await this._sellOnGE(ctx);
    }
  }

  async _depositGold(ctx) {
    const gold = ctx.get().gold;
    if (gold <= 0) return;

    await moveTo(ctx, BANK.x, BANK.y);
    log.info(`[${ctx.name}] Depositing ${gold}g to bank`);
    try {
      const result = await api.depositGold(gold, ctx.name);
      await api.waitForCooldown(result);
      await ctx.refresh();
    } catch (err) {
      log.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`);
    }
  }

  async _autoEquipFromBank(ctx) {
    const bankItems = await gameData.getBankItems(true);
    const upgrades = gameData.findBankUpgrades(ctx, bankItems);

    if (upgrades.length === 0) return;

    for (const { slot, itemCode, scoreDelta } of upgrades) {
      const currentCode = ctx.get()[`${slot}_slot`] || null;

      if (ctx.inventoryFull()) {
        log.info(`[${ctx.name}] Bank auto-equip: inventory full, skipping ${slot}`);
        break;
      }

      log.info(`[${ctx.name}] Bank auto-equip: ${slot}: ${currentCode || '(empty)'} → ${itemCode} (+${scoreDelta.toFixed(1)})`);

      // Withdraw upgrade from bank
      await moveTo(ctx, BANK.x, BANK.y);
      const wr = await api.withdrawBank([{ code: itemCode, quantity: 1 }], ctx.name);
      await api.waitForCooldown(wr);
      await ctx.refresh();

      // Swap equipment and deposit old item back to bank
      let unequipped;
      try {
        ({ unequipped } = await swapEquipment(ctx, slot, itemCode));
      } catch {
        log.info(`[${ctx.name}] Bank auto-equip: inventory full, can't unequip ${slot}`);
        break;
      }

      if (unequipped) {
        await moveTo(ctx, BANK.x, BANK.y);
        const dr = await api.depositBank([{ code: unequipped, quantity: 1 }], ctx.name);
        await api.waitForCooldown(dr);
        await ctx.refresh();
      }
    }
  }

  async _sellOnGE(ctx) {
    try {
      // Force-refresh bank since we just deposited + possibly equipped
      const bankItems = await gameData.getBankItems(true);
      await moveTo(ctx, BANK.x, BANK.y);
      await geSeller.executeSellFlow(ctx, bankItems);
    } catch (err) {
      log.error(`[${ctx.name}] GE sell flow error: ${err.message}`);
    }

    // Always re-deposit any leftover inventory items + gold
    const leftover = ctx.get().inventory.filter(s => s.code);
    if (leftover.length > 0) {
      await moveTo(ctx, BANK.x, BANK.y);
      log.info(`[${ctx.name}] Re-depositing ${leftover.length} unsold item(s)`);
      try {
        const result = await api.depositBank(
          leftover.map(s => ({ code: s.code, quantity: s.quantity })),
          ctx.name,
        );
        await api.waitForCooldown(result);
        await ctx.refresh();
      } catch (err) {
        log.warn(`[${ctx.name}] Could not re-deposit items: ${err.message}`);
      }
    }

    const gold = ctx.get().gold;
    if (gold > 0) {
      await moveTo(ctx, BANK.x, BANK.y);
      log.info(`[${ctx.name}] Depositing ${gold}g from GE collections`);
      try {
        const result = await api.depositGold(gold, ctx.name);
        await api.waitForCooldown(result);
        await ctx.refresh();
      } catch (err) {
        log.warn(`[${ctx.name}] Could not deposit gold: ${err.message}`);
      }
    }
  }
}
