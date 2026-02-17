import { BaseTask } from './base.mjs';
import { depositAll } from '../helpers.mjs';

export class DepositBankTask extends BaseTask {
  constructor({ threshold = 0.8, priority = 50 } = {}) {
    super({ name: 'Deposit to Bank', priority, loop: false });
    this.threshold = threshold;
  }

  canRun(ctx) {
    const count = ctx.inventoryCount();
    const cap = ctx.inventoryCapacity();
    return cap > 0 && (count / cap) >= this.threshold;
  }

  async execute(ctx) {
    await depositAll(ctx);
  }
}
