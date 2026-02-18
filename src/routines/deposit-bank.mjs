import { BaseRoutine } from './base.mjs';
import { depositAll, moveTo } from '../helpers.mjs';
import { BANK } from '../data/locations.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as geSeller from '../services/ge-seller.mjs';
import * as recycler from '../services/recycler.mjs';

export class DepositBankRoutine extends BaseRoutine {
  constructor({
    threshold = 0.8,
    priority = 50,
    sellOnGE = true,
    recycleEquipment = true,
    depositGold = true,
  } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false });
    this.threshold = threshold;
    this.sellOnGE = sellOnGE;
    this.recycleEquipment = recycleEquipment;
    this.depositGold = depositGold;
  }

  canRun(ctx) {
    const count = ctx.inventoryCount();
    const cap = ctx.inventoryCapacity();
    if (cap <= 0) return false;
    if (this.threshold <= 0) return count > 0;
    return (count / cap) >= this.threshold;
  }

  async execute(ctx) {
    // Step 1: Deposit all inventory items to bank
    await depositAll(ctx);

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
    const leftover = ctx.get().inventory.filter(s => s.code);
    if (leftover.length > 0) {
      await moveTo(ctx, BANK.x, BANK.y);
      log.info(`[${ctx.name}] Re-depositing ${leftover.length} unrecycled item(s)`);
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

  async _sellOnGE(ctx) {
    try {
      await moveTo(ctx, BANK.x, BANK.y);
      await geSeller.executeSellFlow(ctx);
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
