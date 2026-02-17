import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';
import { depositAll } from '../helpers.mjs';

const THRESHOLD = 0.8; // trigger when 80% of inventory slots used

export class DepositBankTask extends BaseTask {
  constructor() {
    super({ name: 'Deposit to Bank', priority: 50, loop: false });
  }

  canRun(_char) {
    const used = state.inventoryUsed();
    const total = state.inventorySlots();
    return total > 0 && (used / total) >= THRESHOLD;
  }

  async execute(_char) {
    await depositAll();
  }
}
