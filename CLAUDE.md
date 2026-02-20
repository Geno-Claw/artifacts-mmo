# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Multi-character automation bot for [Artifacts MMO](https://artifactsmmo.com/) (API-driven MMORPG, Season 7). Runs 5 characters concurrently, each with an independent priority-based routine scheduler. ES modules (.mjs), Node.js >=20, minimal dependencies (dotenv, puppeteer-core).

## Commands

```bash
npm start                          # Run bot (all characters concurrently)
npm run dev                        # Run with local config (characters-local.json)
npm run status                     # Quick character status check
npm run test:all                   # Run all tests
npm run test:skill-rotation        # Run a single test suite
node scripts/test-inventory-manager.mjs  # Run any test directly
```

Tests use `node:assert/strict` — no test framework. Each test is a standalone script in `scripts/test-*.mjs`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full details. Key concepts:

**Scheduler loop (per character):** refresh state → pick highest-priority routine where `canRun()` is true → execute → repeat. Loop routines re-check `canRun()` each iteration and support preemption by higher-priority routines.

**Routine interface:** Extend `BaseRoutine` with `canRun(ctx)` → boolean and `async execute(ctx)` → boolean (true = continue loop). Set priority in constructor (higher wins). Optional `canBePreempted(ctx)` override (default true).

**Priority scale:** Rest (100) > Bank deposit (50-70) > Skill rotation (5). SkillRotation handles all gameplay (gathering, crafting, combat, NPC/item tasks, order board, task exchange) via focused executor modules in `src/routines/skill-rotation/`.

**CharacterContext (`src/context.mjs`):** Per-character state wrapper passed to all routines. Provides inventory queries, skill levels, task state, loss tracking, equipment queries. Always use `ctx` methods — never access character data directly.

**API client (`src/api.mjs`):** Auto-retries on cooldown (code 499) and gateway errors. All actions return results with cooldown info — use `waitForCooldown(result)` after every action.

**Helpers (`src/helpers.mjs`):** Thin action wrappers that handle cooldown waits and state refresh internally — `moveTo`, `fightOnce`, `gatherOnce`, `swapEquipment`, `depositAll`, `withdrawItem`, etc. Gear loadout logic lives in `services/gear-loadout.mjs`, food/healing in `services/food-manager.mjs` (both re-exported from helpers for backward compat).

## Key Patterns

- **Inventory capacity** is total item COUNT (`inventory_max_items`), not slot count. Use `ctx.inventoryCount()` / `ctx.inventoryCapacity()` / `ctx.inventoryFull()`.
- **Bank operations** go through `services/bank-ops.mjs` with reservation-aware concurrency control. Bank travel (tile discovery, teleport potions) is in `services/bank-travel.mjs`. Never call `api.withdrawBank()` directly.
- **Gear ownership** tracked in `services/gear-state.mjs` — prevents selling/recycling items assigned to characters or orders. Requirements computation in `gear-requirements.mjs`, fallback claims in `gear-fallback.mjs`, loadout application in `gear-loadout.mjs`.
- **Equipment utilities** shared across gear modules live in `services/equipment-utils.mjs` (item classification, equipped counts).
- **Order board** (`services/order-board.mjs`) coordinates multi-character crafting with claims, leases, and item deposits.
- **Item types** use slot name directly (e.g., `type: "boots"`), NOT `type: "equipment"` with a subtype.
- **Equipment scoring** uses weighted effect sums (`data/scoring-weights.mjs`), but gear optimizer uses combat simulation for actual decisions.
- **Grand Exchange** supports both sell orders and buy orders (Season 7). Sell endpoint is `/grandexchange/create-sell-order` (renamed from `/sell`). Buy orders lock gold upfront; filled items go to the pending items queue.
- **Pending items** system delivers items without needing inventory space (achievement rewards, GE buy order fills). Claim via `/action/claim_item/{id}` with any character.

## Adding a New Routine

1. Create `src/routines/my-routine.mjs` extending `BaseRoutine`
2. Register it in `src/routines/factory.mjs` (`buildRoutines()`)
3. Re-export from `src/routines/index.mjs`
4. Add config entry to `config/characters.json`

## SkillRotation Executor Pattern

`src/routines/skill-rotation/` is split into focused executor modules (gathering, combat, crafting, npc-tasks, item-tasks, task-exchange, order-claims). Each exports standalone functions receiving `(ctx, routine)`. The `index.mjs` class has thin one-line wrappers that delegate to them.

**Critical:** All cross-calls between executors MUST go through `routine._methodName()`, never direct function calls. Tests monkey-patch methods on the routine instance — direct calls bypass mocks.

## Configuration

- `config/characters.json` — per-character routine configs with weights, goals, settings
- `config/sell-rules.json` — GE selling whitelist and recycler rules
- `.env` — `ARTIFACTS_TOKEN` (required), `BOT_CONFIG`, `PORT` (dashboard, default 3000)
- Both config files have companion `.schema.json` validators

## File Conventions

- All source files are `.mjs` (ES modules with explicit extensions in imports)
- Services in `src/services/` are typically singletons or stateless utilities
- Game coordinates and static data live in `src/data/locations.mjs`
- Tests mock API/services inline — no shared test fixtures
- Persistent state files (gear-state, order-board) write to `./report/` with atomic writes
