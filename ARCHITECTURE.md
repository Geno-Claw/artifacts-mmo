# Bot Architecture

## How It Works

The bot loads `config/characters.json`, creates a `CharacterContext` + `Scheduler` for each character, and runs them all concurrently via `Promise.all`. Each character runs an independent forever loop:

```
refresh character state → pick highest-priority runnable routine → execute it → repeat
```

When HP drops low, Rest (priority 100) takes over. When inventory fills up, Bank (priority 50) takes over. Otherwise it runs skill rotation, NPC tasks, or direct grinding. This creates emergent behavior from simple rules.

## File Layout

```
src/
  bot.mjs               Entry point — loads config, inits game data, starts all characters
  scheduler.mjs          The "brain" — picks and runs routines per character
  context.mjs            CharacterContext — per-character state wrapper
  helpers.mjs            Reusable action patterns (moveTo, equipForCombat, depositAll, etc.)
  api.mjs                HTTP client for all API calls, auto-retry on cooldown
  log.mjs                Timestamped console logging
  data/
    locations.mjs        Monster, resource, and bank coordinates (Season 7)
    scoring-weights.mjs  Equipment scoring multipliers
  services/
    game-data.mjs        Static game data cache (items, monsters, resources, recipes)
    combat-simulator.mjs Pure math fight predictor using game damage formulas
    gear-optimizer.mjs   Simulation-based equipment optimizer (3-phase greedy)
    potion-manager.mjs   Combat utility potion selection + refill manager
    ge-seller.mjs        Grand Exchange selling flow (whitelist-only, pricing, order mgmt)
    recycler.mjs         Equipment recycling at workshops (surplus → crafting materials)
    skill-rotation.mjs   State machine for multi-skill cycling
  routines/
    base.mjs             BaseRoutine abstract class
    factory.mjs           buildRoutines() — parses config into routine instances
    index.mjs             Re-exports all routine classes
    rest.mjs              Priority 100 — rest when HP low, eats food first
    deposit-bank.mjs      Priority 50  — bank when inventory full, recycle equipment, optional GE selling
    skill-rotation/       Priority 5   — weighted multi-skill rotation (see below)
      index.mjs           SkillRotationRoutine class — orchestrator with thin wrappers
      constants.mjs       Shared constants (skill sets, task coin config, reserve limits)
      gathering.mjs       Mining, woodcutting, fishing + smelting executor
      combat.mjs          Monster fighting executor
      crafting.mjs        Multi-step recipe crafting, batch management, inventory helpers
      npc-tasks.mjs       NPC task accept/fight/complete flow
      item-tasks.mjs      Item task accept/gather/craft/trade flow
      task-exchange.mjs   Task coin exchange for rewards
      order-claims.mjs    Order board claim lifecycle (acquire, renew, deposit, release)
config/
  characters.json         Per-character routine configuration
  sell-rules.json         Grand Exchange sell rules
  *.schema.json           JSON Schema validators
scripts/
  export-gear-scores.mjs  Export all equipment to CSV with scoring breakdown
```

## Core Concepts

### Routines

Every routine extends `BaseRoutine` and implements two methods:

```js
class MyRoutine extends BaseRoutine {
  canRun(ctx)           // → boolean: "can I run right now?"
  async execute(ctx)    // → boolean (loop routines): true = keep going, false = stop
}
```

Routines declare three properties in their constructor:
- **name** — for logging
- **priority** — higher number wins (Rest=100, Bank=50, Grind=10)
- **loop** — if true, execute() is called repeatedly until it returns false or canRun() fails

Optional override:
- **`canBePreempted(ctx)`** — returns boolean (default `true`). When `false`, the scheduler skips preemption even if a higher-priority routine is runnable. Used by `SkillRotationRoutine` to complete full goal cycles before yielding to bank/rest.

All routines receive a `CharacterContext` (not a raw character object).

### Scheduler

The scheduler holds a priority-sorted list of routines. Each iteration:

1. Refreshes character state from the API
2. Walks the routine list top-down, calls `canRun()` on each
3. Runs the first routine that returns true
4. For loop routines: re-checks `canRun()` before each iteration, and checks for higher-priority preemption
5. Preemption is gated by `routine.canBePreempted(ctx)` — routines can defer preemption until a safe break point (e.g., skill rotation only yields between goal cycles, not mid-action)

### Scheduler ↔ Executor Interaction

Understanding how the scheduler routines (Rest, Bank) and the SkillRotation executors share responsibility for resting and banking is critical for avoiding duplication or regressions.

**Why executors have inline rest/bank operations:**

`SkillRotationRoutine.canBePreempted()` returns `true` only between goals (no skill selected or goal complete). This means RestRoutine and BankRoutine **cannot preempt mid-goal**. Executors must handle their own resting and targeted bank operations during a goal cycle.

The one exception: `canRun()` returns `false` when inventory is full, which **always** breaks the loop regardless of `canBePreempted()`. This lets BankRoutine run when truly needed.

**Two-layer design:**

| Concern | Scheduler routine | Executor inline |
|---------|------------------|-----------------|
| **Resting** | RestRoutine: between-goal safety net (HP < 40% → heal to 80%) | `restBeforeFight()`: surgical heal to exact minimum HP for a specific fight |
| **Deposits** | BankRoutine: bulk deposit all + recycle + GE sell + gold | Targeted deposits: claim items, exchange rewards, craft products (reserve pressure) |
| **Withdrawals** | *(none)* | All withdrawals are inline: food, materials, gear, coins, task items |

**The `return !ctx.inventoryFull()` protocol:**

Every executor returns `false` when inventory is full. This breaks the loop, letting BankRoutine run naturally. After bank deposits, `canRun()` passes again and SkillRotation resumes.

**Bank deposit recovery:**

When BankRoutine runs between goals and deposits everything (including items the executor needs), the executor must detect this and re-withdraw. Patterns:
- **Crafting**: `bankChecked` flag resets when inventory is empty → triggers re-withdrawal of craft materials
- **Combat/NPC tasks**: `_foodWithdrawn` flag resets when inventory is empty → triggers food re-withdrawal

**Future: Event/urgent preemption**

`canBePreempted()` currently blocks ALL preemption mid-goal, including high-priority event routines. To support group events (all characters drop everything and participate), add an `urgent` flag to `BaseRoutine` (default `false`). The scheduler preemption check becomes: `if (preempt && (preempt.urgent || routine.canBePreempted(this.ctx)))` — one line in `scheduler.mjs`. Event routines set `urgent: true` to bypass `canBePreempted()`. Cross-character coordination (shared event service, synchronization) is the larger piece of work.

### CharacterContext

Per-character state wrapper (replaces old singleton `state.mjs`). One instance per character.

| Method | Returns |
|--------|---------|
| `refresh()` | Fetches latest from API, detects level-ups |
| `get()` | Full character object |
| `hpPercent()` | Current HP as percentage |
| `isAt(x, y)` | Whether character is at coords |
| `hasItem(code, qty)` | Whether inventory contains item |
| `itemCount(code)` | Quantity of item in inventory |
| `inventoryCount()` | Total item count across all slots |
| `inventoryCapacity()` | Max items (`inventory_max_items`) |
| `inventoryFull()` | Count >= capacity? |
| `hasTask()` | Has an active NPC task? |
| `taskComplete()` | Task progress >= total? |
| `skillLevel(name)` | Level of a skill (e.g. 'mining') |
| `equippedItem(slot)` | Item code in equipment slot |
| `recordLoss(monster)` | Track consecutive loss |
| `consecutiveLosses(m)` | Query loss count |
| `taskCoins()` | NPC task coin balance |
| `settings()` | Character-level settings (e.g. potion automation) |

**Level-up behavior:** On level-up, all loss counters reset and the gear cache is cleared, so the bot retries previously-failed monsters and re-evaluates equipment.

### Helpers

DRY wrappers that handle `waitForCooldown` + `ctx.refresh()` internally:

| Helper | What it does |
|--------|-------------|
| `moveTo(ctx, x, y)` | Move if not already there |
| `restUntil(ctx, pct)` | Eat food first, then rest API until HP% |
| `restBeforeFight(ctx, monster)` | Rest to minimum HP needed for a fight |
| `fightOnce(ctx)` | Single fight, returns result |
| `gatherOnce(ctx)` | Single gather, returns result |
| `swapEquipment(ctx, slot, code)` | Unequip + equip in one slot |
| `equipForCombat(ctx, monster)` | Full gear optimization with caching |
| `parseFightResult(result, ctx)` | Extract win/xp/gold/drops from fight |
| `depositAll(ctx)` | Move to bank, deposit all inventory |
| `withdrawItem(ctx, code, qty)` | Move to bank, withdraw via reservation-backed bank ops |
| `withdrawPlanFromBank(ctx, plan)` | Withdraw items for a crafting plan |
| `rawMaterialNeeded(ctx, plan, code)` | Remaining material needed for a plan |
| `clearGearCache(charName)` | Reset gear cache (called on level-up) |

## Services

### Game Data (`services/game-data.mjs`)
Loads items, monsters, resources, maps, and bank contents from the API at startup. Provides lookups (`getItem`, `getMonster`, `getResource`), equipment scoring (`scoreItem`), recipe resolution (`resolveRecipeChain`), and location helpers (`getResourceLocation`, `getWorkshops`).

### Combat Simulator (`services/combat-simulator.mjs`)
Pure math fight predictor using the documented Artifacts MMO damage formulas. Key exports:
- `simulateCombat(char, monster)` — predict fight outcome
- `canBeatMonster(ctx, monsterCode)` — win with ≥20% HP remaining
- `hpNeededForFight(ctx, monsterCode)` — minimum HP to survive

### Gear Optimizer (`services/gear-optimizer.mjs`)
Simulation-based equipment selection. Three-phase greedy approach:
1. **Weapon** — maximize outgoing DPS
2. **Defensive slots** (shield, helmet, body, legs, boots) — maximize HP remaining via combat sim
3. **Accessories** (rings, amulet) — maximize HP remaining via combat sim

Considers items from bank, inventory, and currently equipped. Handles ring deduplication.

### Bank Ops (`services/bank-ops.mjs`)
Shared item-withdraw service used by helpers, recycler, and GE seller:
- Centralizes all `api.withdrawBank` calls in one place
- Uses reservation-aware availability (`availableBankCount` + `reserveMany`)
- Supports partial-fill defaults, one forced refresh retry, and per-item fallback
- Applies immediate bank deltas (`applyBankDelta`) after successful withdrawals
- Handles smart travel to the nearest accessible bank and can optionally consume teleport potions when modeled travel time is lower than direct movement

### Potion Manager (`services/potion-manager.mjs`)
Combat utility automation service:
- Utility policy: `utility1` prefers `restore`, then `splash_restore`, then simulation fallback
- `utility2` picks the best remaining simulation candidate (never overlaps `utility1`)
- Refills utility stacks at a configurable threshold/target
- Can preserve non-potion utility items in occupied slots

### Recycler (`services/recycler.mjs`)
Equipment recycling at workshops. Surplus equipment is broken down into crafting materials instead of being sold on the GE:
- Identify recycle candidates from unclaimed equipment/jewelry only (gear-state ownership is protected)
- Group by `craft.skill` to minimize workshop travel (e.g., weaponcrafting, gearcrafting, jewelrycrafting)
- Withdraw → move to workshop → recycle → deposit materials flow
- Mid-batch inventory management: deposits materials to bank when inventory hits 90% capacity
- Items without `craft.skill` (uncraftable/event items) are skipped
- Contention control: reservation-backed bank withdrawals (no recycler-level mutex)

### GE Seller (`services/ge-seller.mjs`)
Grand Exchange selling automation — **whitelist-only** (only `alwaysSell` rules):
- Equipment duplicates are handled by the recycler, not the GE
- Price via undercut strategy (configured % below lowest listing)
- Withdraw → list → deposit flow with inventory verification before each sell order
- Order collection and stale order cancellation
- Concurrency control: async mutex ensures only one character runs GE order flow at a time
- Season 7: sell endpoint renamed to `create-sell-order`; GE also supports buy orders and the pending items delivery system

### Bank Data (`getBankItems` in `services/game-data.mjs`)
Bank contents are fetched via paginated API (100 items/page) and cached with a 60s TTL. Key safeguards:
- **Last-write-wins**: Each item code exists once in the bank (items stack). If pagination shifts cause a duplicate across pages, the latest value is used rather than accumulating — prevents over-counting when concurrent deposits/withdrawals shift items between pages.
- **In-flight fetch guard**: If a fetch is already in progress, concurrent callers reuse the same promise instead of starting parallel fetches.
- **Local-then-assign**: The map is built in a local variable and assigned to the cache only when complete, so concurrent readers never see a partially-built map.
- **Reservation-aware withdrawals**: All item withdrawals route through `services/bank-ops.mjs`, reducing race conditions across characters.

### Skill Rotation (`services/skill-rotation.mjs`)
State machine for `SkillRotationRoutine`. Tracks current skill, goal progress, and production plans. Supports weighted random skill selection with configurable goals per skill.
- Alchemy is hybrid in rotation: try crafting first, and if no viable alchemy recipe exists, fall back to alchemy gathering to bootstrap progression.

### SkillRotation Routine (`routines/skill-rotation/`)

The main gameplay routine, split into focused executor modules. The `index.mjs` class is the orchestrator — it owns all mutable state and exposes thin one-line wrapper methods (`_executeGathering`, `_batchSize`, `_claimOrderForChar`, etc.) that delegate to standalone functions in the executor files.

**Executor pattern:** Each executor exports functions that receive `(ctx, routine)`. The `routine` parameter provides access to shared state and other executors via `routine._methodName()`.

```
index.mjs        — SkillRotationRoutine class, execute() dispatch, small helpers
gathering.mjs    — executeGathering(), trySmelting()
combat.mjs       — executeCombat()
crafting.mjs     — executeCrafting(), batchSize(), withdrawFromBank(), inventory helpers
npc-tasks.mjs    — executeNpcTask(), runNpcTaskFlow(), task type inference
item-tasks.mjs   — runItemTaskFlow(), craftForItemTask(), gatherForItemTask(), trade flow
task-exchange.mjs — runTaskExchange(), proactive exchange, coin management
order-claims.mjs — ensureOrderClaim(), acquire/deposit/release claim lifecycle
constants.mjs    — GATHERING_SKILLS, CRAFTING_SKILLS, TASK_COIN_CODE, reserve limits
```

**Critical rule:** All cross-calls between executor functions MUST go through `routine._methodName()`, never direct function calls. Tests monkey-patch methods on the routine instance, so direct calls would bypass mocks. For example, `executeCrafting` must call `routine._batchSize(ctx)` not `batchSize(ctx, routine)`.

## Configuration

### `config/characters.json`

```json
{
  "characters": [
    {
      "name": "GenoClaw",
      "routines": [
        { "type": "rest", "triggerPct": 40, "targetPct": 80 },
        { "type": "depositBank", "threshold": 0.8, "recycleEquipment": true, "sellOnGE": true },
        { "type": "skillRotation", "weights": { "mining": 1, "combat": 1 }, "goals": { "mining": 20 } }
      ]
    }
  ]
}
```

Routine types: `rest`, `depositBank`, `skillRotation`. SkillRotation handles all gameplay (gathering, crafting, combat, NPC tasks, item tasks, order board fulfillment, task coin exchange) internally via its executor modules.
Character `settings` can optionally include potion automation controls (`settings.potions.combat`, `settings.potions.bankTravel`).

### `config/sell-rules.json`

Controls equipment recycling and GE selling:
- `sellDuplicateEquipment` — recycle surplus unclaimed equipment/jewelry at workshops
- `alwaysSell` — whitelist of items to sell on the GE (the only items that go to GE)
- `neverSell` — item codes exempt from both recycling and GE selling
- `pricingStrategy` — "undercut" with configurable `undercutPercent` (for GE listings)

## Priority Scale

| Range | Purpose | Examples |
|-------|---------|---------|
| 90–100 | Survival | Rest when HP low |
| 50–70 | Maintenance | Bank deposits |
| 5 | Core gameplay | Skill rotation (handles all gathering, crafting, combat, tasks) |

## Equipment Scoring

Static scoring via weighted sum of item effects (`data/scoring-weights.mjs`):

| Effect | Weight | Rationale |
|--------|--------|-----------|
| haste | 4x | Most impactful combat stat |
| attack_* | 3x | Direct damage scaling |
| dmg, dmg_* | 2x | Flat damage bonuses |
| res_* | 1.5x | Damage reduction |
| hp | 0.5x | Raw values are large (50-500) |
| initiative | 0.2x | Raw values 50-700, would dominate at 1x |
| wisdom | 0.2x | High raw values, non-combat |
| prospecting | 0.1x | High raw values, non-combat |

The gear optimizer uses combat simulation instead of static scores for actual equipment decisions.

## Adding a New Routine

1. Create `src/routines/my-routine.mjs`:

```js
import { BaseRoutine } from './base.mjs';

export class MyRoutine extends BaseRoutine {
  constructor() {
    super({ name: 'My Routine', priority: 20, loop: false });
  }

  canRun(ctx) {
    return ctx.get().level >= 5 && !ctx.inventoryFull();
  }

  async execute(ctx) {
    // do the thing
  }
}
```

2. Add it to `buildRoutines()` in `src/routines/factory.mjs` with a config type mapping.

3. Add the routine config to `config/characters.json` for the desired characters.

## Running

```bash
npm start          # runs src/bot.mjs — all characters start concurrently
```

Environment (`.env`):
```
ARTIFACTS_TOKEN=your_token
```

Characters are configured entirely in `config/characters.json`. Ctrl+C to stop.

## Season 7 Changes

Key API/game changes from Season 6 → Season 7:

- **GE sell endpoint renamed**: `/grandexchange/sell` → `/grandexchange/create-sell-order`
- **GE buy orders**: New `create-buy-order` and `fill` endpoints. Buy orders lock gold; filled items delivered via pending items.
- **Pending items system**: Account-wide queue for receiving items (GE buy order fills, achievement rewards). Claim with any character via `claim_item/{id}`.
- **Achievements**: Now support multiple objectives and item rewards (delivered via pending items).
- **Rest formula**: Changed from 1s per 5 missing HP to 1s per 1% missing HP (min 3s). Server-side — no bot code impact.
- **New combat effect**: Protective Bubble — grants random elemental resistance each turn (element rotates, never same twice in a row).
- **New monsters**: Rat (level 25), Goblin Guard (level 35), Goblin Priestess boss (level 35). Loaded dynamically via game-data.
- **GE order schema**: Orders now have `type` (sell/buy) and unified `account` field instead of separate `seller`/`buyer`.
