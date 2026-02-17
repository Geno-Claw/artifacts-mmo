import { BaseTask } from './base.mjs';
import { depositAll } from '../helpers.mjs';

export class DepositBankTask extends BaseTask {
  constructor({ threshold = 0.8, priority = 50 } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false });
    this.threshold = threshold;
  }

  canRun(ctx) {
    const used = ctx.inventoryUsed();
    const total = ctx.inventorySlots();
    return total > 0 && (used / total) >= this.threshold;
  }

  async execute(ctx) {
    await depositAll(ctx);
  }
}
