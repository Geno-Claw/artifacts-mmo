# Bot Architecture

## How It Works

The bot runs a forever loop:

```
refresh character state → pick highest-priority runnable task → execute it → repeat
```

When HP drops low, Rest (priority 100) takes over. When inventory fills up, Bank (priority 50) takes over. Otherwise it grinds/gathers (priority 10). This creates emergent behavior from simple rules.

## File Layout

```
src/
  bot.mjs              Entry point — wires everything, starts the loop
  scheduler.mjs        The "brain" — picks and runs tasks
  state.mjs            Character state singleton + convenience accessors
  helpers.mjs          Reusable action patterns (moveTo, restUntil, fightOnce, etc.)
  log.mjs              Timestamped console logging
  api.mjs              HTTP client for all API calls
  data/
    locations.mjs      Monster, resource, and bank coordinates
  tasks/
    index.mjs          Task registry — imports all tasks, exports defaultTasks()
    base.mjs           BaseTask class
    rest.mjs            Priority 100 — rest when HP < 40%
    deposit-bank.mjs    Priority 50  — bank when inventory ≥ 80% full
    do-task.mjs         Priority 60/5 — complete/accept NPC tasks
    fight-monsters.mjs  Priority 10  — combat grinding (configurable per monster)
    gather-resource.mjs Priority 10  — resource gathering (configurable per resource)
```

## Core Concepts

### Tasks

Every task extends `BaseTask` and implements two methods:

```js
class MyTask extends BaseTask {
  canRun(char)          // → boolean: "can I run right now?"
  async execute(char)   // → boolean (loop tasks): true = keep going, false = stop
}
```

Tasks declare three properties in their constructor:
- **name** — for logging
- **priority** — higher number wins (Rest=100, Bank=50, Grind=10)
- **loop** — if true, execute() is called repeatedly until it returns false or canRun() fails

Prerequisites are plain code in `canRun()`. No DSL, no config — just check whatever you need:

```js
canRun(char) {
  if (char.level < 5) return false;
  if (state.hpPercent() < 30) return false;
  if (state.inventoryFull()) return false;
  return true;
}
```

### Scheduler

The scheduler holds a priority-sorted list of tasks. Each iteration:

1. Refreshes character state from the API
2. Walks the task list top-down, calls `canRun()` on each
3. Runs the first task that returns true
4. For loop tasks: re-checks `canRun()` before each iteration so higher-priority tasks can interrupt

### State

`state.mjs` is a module-level singleton (not a class). Call `refresh()` to pull from API, then use accessors:

| Function | Returns |
|----------|---------|
| `get()` | Full character object |
| `hpPercent()` | Current HP as percentage |
| `isAt(x, y)` | Whether character is at coords |
| `hasItem(code, qty)` | Whether inventory contains item |
| `itemCount(code)` | Quantity of item in inventory |
| `inventoryUsed()` | Number of occupied slots |
| `inventoryFull()` | All slots occupied? |
| `hasTask()` | Has an active NPC task? |
| `taskComplete()` | Task progress >= total? |
| `skillLevel(name)` | Level of a skill (e.g. 'mining') |

### Helpers

DRY wrappers that handle `waitForCooldown` + `state.refresh()` internally:

| Helper | What it does |
|--------|-------------|
| `moveTo(x, y)` | Move if not already there (no-op if at target) |
| `restUntil(pct)` | Loop rest until HP reaches percentage |
| `fightOnce()` | Single fight, returns result |
| `gatherOnce()` | Single gather, returns result |
| `depositAll()` | Move to bank, deposit all inventory |

Tasks call these instead of raw `api.*` functions so they never need to worry about cooldowns or state refresh.

## Priority Scale

| Range | Purpose | Examples |
|-------|---------|---------|
| 90–100 | Survival | Rest when HP low |
| 50–70 | Maintenance | Bank deposits, complete NPC tasks |
| 10–30 | Core gameplay | Fight monsters, gather resources |
| 1–9 | Background | Accept new tasks |

## Adding a New Task

1. Create `src/tasks/my-task.mjs`:

```js
import { BaseTask } from './base.mjs';
import * as state from '../state.mjs';

export class MyTask extends BaseTask {
  constructor() {
    super({ name: 'My Task', priority: 20, loop: false });
  }

  canRun(char) {
    // return true when this task should run
    return char.level >= 5 && !state.inventoryFull();
  }

  async execute(char) {
    // do the thing
  }
}
```

2. Register it in `src/tasks/index.mjs`:

```js
import { MyTask } from './my-task.mjs';

export function defaultTasks() {
  return [
    // ...existing tasks...
    new MyTask(),
  ];
}
```

That's it. The scheduler picks it up automatically.

## Configurable Tasks

`FightMonstersTask` and `GatherResourceTask` take constructor args, so you can create multiple instances targeting different things:

```js
export function defaultTasks() {
  return [
    new RestTask(),
    new DepositBankTask(),
    new FightMonstersTask('chicken', { priority: 10 }),
    new FightMonstersTask('cow', { priority: 11 }),         // preferred over chicken
    new GatherResourceTask('copper_ore', { priority: 8 }),  // lower than fighting
  ];
}
```

Higher-level monsters get higher priority so the bot farms the toughest thing it can handle. The `canRun()` check ensures it won't attempt monsters above its level.

## Running

```bash
npm start          # runs src/bot.mjs
```

Environment (`.env`):
```
ARTIFACTS_TOKEN=your_token
CHARACTER_NAME=GenoClaw
```

Ctrl+C to stop gracefully.
