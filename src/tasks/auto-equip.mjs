import { BaseTask } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import { moveTo, swapEquipment } from '../helpers.mjs';
import { BANK } from '../data/locations.mjs';
import * as gameData from '../services/game-data.mjs';
import { EQUIPMENT_SLOTS } from '../services/game-data.mjs';

/**
 * Periodically scans inventory + bank for gear upgrades and equips them.
 * Withdraws from bank if needed.
 */
export class AutoEquipTask extends BaseTask {
  constructor({ priority = 45, checkInterval = 300_000, slots } = {}) {
    super({ name: 'Auto-Equip', priority, loop: false });
    this.checkInterval = checkInterval;
    this.slots = slots || EQUIPMENT_SLOTS;
    this._lastCheck = 0;
    this._pendingUpgrades = [];
    this._checkBank = false;
  }

  canRun(ctx) {
    const now = Date.now();
    if (now - this._lastCheck < this.checkInterval) return false;

    // Quick check: any inventory-only upgrades?
    // Full check (including bank) happens in execute().
    this._pendingUpgrades = this._findUpgrades(ctx, null);
    if (this._pendingUpgrades.length > 0) {
      this._lastCheck = now;
      return true;
    }

    // Even without inventory upgrades, periodically check bank too
    this._lastCheck = now;
    this._checkBank = true;
    return true;
  }

  _findUpgrades(ctx, bankItems) {
    const char = ctx.get();
    const upgrades = [];

    for (const slot of this.slots) {
      const currentCode = char[`${slot}_slot`] || null;
      const currentItem = currentCode ? gameData.getItem(currentCode) : null;
      const currentScore = currentItem ? gameData.scoreItem(currentItem) : 0;

      const candidates = gameData.getEquipmentForSlot(slot, char.level);
      let bestItem = null;
      let bestScore = currentScore;
      let bestSource = null;

      for (const candidate of candidates) {
        const score = gameData.scoreItem(candidate);
        if (score <= bestScore) continue;
        if (candidate.code === currentCode) continue;

        // Check availability: inventory first, then bank
        if (ctx.hasItem(candidate.code)) {
          bestItem = candidate;
          bestScore = score;
          bestSource = 'inventory';
        } else if (bankItems && (bankItems.get(candidate.code) || 0) >= 1) {
          bestItem = candidate;
          bestScore = score;
          bestSource = 'bank';
        }
      }

      if (bestItem) {
        log.info(`[${ctx.name}] Auto-Equip: ${slot}: ${currentCode || '(empty)'} (${currentScore.toFixed(1)}) → ${bestItem.code} (${bestScore.toFixed(1)}) from ${bestSource}`);
        upgrades.push({
          slot,
          itemCode: bestItem.code,
          source: bestSource,
          scoreDelta: bestScore - currentScore,
        });
      }
    }

    upgrades.sort((a, b) => b.scoreDelta - a.scoreDelta);
    return upgrades;
  }

  async execute(ctx) {
    // Re-find upgrades with actual bank data for the full picture
    const bankItems = await gameData.getBankItems(true);
    const upgrades = this._findUpgrades(ctx, bankItems);
    this._checkBank = false;

    if (upgrades.length === 0) {
      log.info(`[${ctx.name}] Auto-Equip: no upgrades found`);
      return;
    }

    for (const upgrade of upgrades) {
      const { slot, itemCode, source } = upgrade;

      // Withdraw from bank if needed
      if (source === 'bank') {
        if (ctx.inventoryFull()) {
          log.info(`[${ctx.name}] Auto-Equip: inventory full, can't withdraw ${itemCode}`);
          break;
        }
        await moveTo(ctx, BANK.x, BANK.y);
        const wr = await api.withdrawBank([{ code: itemCode, quantity: 1 }], ctx.name);
        await api.waitForCooldown(wr);
        await ctx.refresh();
      }

      // Swap equipment in the slot
      try {
        await swapEquipment(ctx, slot, itemCode);
      } catch {
        log.info(`[${ctx.name}] Auto-Equip: inventory full, can't unequip ${slot}`);
        break;
      }
    }

    this._pendingUpgrades = [];
  }
}
