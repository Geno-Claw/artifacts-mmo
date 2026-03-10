#!/usr/bin/env node
import assert from 'node:assert/strict';

import { Scheduler } from '../src/scheduler.mjs';
import { BaseRoutine } from '../src/routines/base.mjs';

function makeCtx(name = 'Tester') {
  return {
    name,
    async refresh() {},
    cooldownRemainingMs() {
      return 0;
    },
  };
}

class StaticRoutine extends BaseRoutine {
  constructor({ name, priority, loop = false, runnable = true, effectivePriority = null, urgent = false }) {
    super({ name, priority, loop, urgent });
    this._runnable = runnable;
    this._effectivePriority = effectivePriority;
  }

  canRun() {
    return this._runnable;
  }

  effectivePriority() {
    return this._effectivePriority ?? this.priority;
  }

  isUrgent() {
    return this.urgent === true;
  }

  async execute() {
    return false;
  }
}

console.log('Test: scheduler selects highest effective priority routine');
{
  const ctx = makeCtx();
  const deposit = new StaticRoutine({
    name: 'Deposit',
    priority: 50,
    runnable: true,
  });
  const boss = new StaticRoutine({
    name: 'BossFight',
    priority: 15,
    runnable: true,
    effectivePriority: 95,
    urgent: true,
  });

  const scheduler = new Scheduler(ctx, [deposit, boss]);
  const { routine, candidates, priority, urgent } = scheduler.pickRoutineWithDetails();

  assert.equal(routine?.name, 'BossFight');
  assert.equal(priority, 95);
  assert.equal(urgent, true);
  assert.deepEqual(
    candidates.map(({ name, priority: p, urgent: u, runnable }) => ({ name, priority: p, urgent: u, runnable })),
    [
      { name: 'Deposit', priority: 50, urgent: false, runnable: true },
      { name: 'BossFight', priority: 95, urgent: true, runnable: true },
    ],
  );
}
console.log('  PASS');

console.log('Test: urgent higher effective priority routine preempts active loop');
{
  const ctx = makeCtx();
  let bossActive = false;
  let normalRuns = 0;
  let bossRuns = 0;
  let resolveBossRun;
  const bossRan = new Promise(resolve => {
    resolveBossRun = resolve;
  });

  class NormalRoutine extends BaseRoutine {
    constructor() {
      super({ name: 'Normal', priority: 5, loop: true });
    }

    canRun() {
      return true;
    }

    canBePreempted() {
      return false;
    }

    async execute() {
      normalRuns += 1;
      if (normalRuns === 1) {
        bossActive = true;
      }
      return true;
    }
  }

  class BossRoutine extends BaseRoutine {
    constructor() {
      super({ name: 'BossFight', priority: 15, loop: true });
    }

    canRun() {
      return bossActive;
    }

    effectivePriority() {
      return bossActive ? 95 : this.priority;
    }

    isUrgent() {
      return bossActive;
    }

    async execute() {
      bossRuns += 1;
      resolveBossRun();
      return false;
    }
  }

  const scheduler = new Scheduler(ctx, [new NormalRoutine(), new BossRoutine()]);
  scheduler._sleep = async () => true;

  const runPromise = scheduler.run();
  await bossRan;
  await scheduler.stop();
  await runPromise;

  assert.equal(normalRuns, 1);
  assert.equal(bossRuns, 1);
}
console.log('  PASS');

console.log('test-scheduler: PASS');
