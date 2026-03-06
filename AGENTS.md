# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## What This Is

Multi-character automation bot for [Artifacts MMO](https://artifactsmmo.com/) (API-driven MMORPG, Season 7). Runs 5 characters concurrently, each with an independent priority-based routine scheduler. ES modules (.mjs), Node.js >=20, minimal dependencies (dotenv, puppeteer-core, ws).

## Commands

```bash
npm start                                # Run bot (all characters concurrently)
npm run dev                              # Run with local config (characters-local.json)
npm run status                           # Quick character status check
npm run test:all                         # Run all tests
npm run test:skill-rotation              # Run a single test suite by name
node scripts/test-inventory-manager.mjs  # Run any test directly
```

Tests use `node:assert/strict` — no test framework. Each test is a standalone script in `scripts/test-*.mjs`. Tests mock API/services inline with fake objects and `_resetForTests`/`_setApiClientForTests` helpers exposed by modules — no shared test fixtures.

To add a new test to the full suite, append it to the `test:all` script chain in `package.json`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for exhaustive details. Summary of key concepts below.

### Scheduler Loop (per character)

`bot.mjs` → `runtime-manager.mjs` → creates `CharacterContext` + `Scheduler` per character → runs all concurrently via `Promise.all`.

Each character runs a forever loop:
```
apply pending config → refresh state → pick highest-priority runnable routine → execute → repeat
```

### Routine System

Every routine extends `BaseRoutine` (`src/routines/base.mjs`) with `canRun(ctx)` → boolean and `async execute(ctx)` → boolean. Priority determines selection order (higher wins). Loop routines re-execute until `execute()` returns false or `canRun()` fails.

**Priority scale:** Rest (100) > Bank deposit (50-70) > Order fulfillment (8) > Skill rotation (5).

**Preemption:** Gated by `canBePreempted(ctx)`. SkillRotation only yields between goal cycles, not mid-action. The exception: `canRun()` returning false (e.g., inventory full) always breaks the loop. Routines with `urgent: true` bypass `canBePreempted()`.

### Two-Layer Rest/Bank Design

This is critical for avoiding duplication:
- **Scheduler routines** (RestRoutine, BankRoutine): safety nets that run between goals
- **Executor inline operations**: surgical rest/withdraw/deposit during a goal cycle when preemption is blocked
- Every executor returns `false` when inventory is full → breaks loop → BankRoutine runs → SkillRotation resumes

### SkillRotation Executor Pattern

`src/routines/skill-rotation/` is split into focused executor modules (gathering, combat, crafting, npc-tasks, item-tasks, task-exchange, order-claims, achievements). Each exports standalone functions receiving `(ctx, routine)`. The `index.mjs` class has thin one-line wrappers that delegate to them.

**Critical:** All cross-calls between executors MUST go through `routine._methodName()`, never direct function calls. Tests monkey-patch methods on the routine instance — direct calls bypass mocks.

### CharacterContext (`src/context.mjs`)

Per-character state wrapper passed to all routines. Provides inventory queries, skill levels, task state, loss tracking, equipment queries. Always use `ctx` methods — never access character data directly.

Inventory capacity is total item COUNT (`inventory_max_items`), not slot count. Use `ctx.inventoryCount()` / `ctx.inventoryCapacity()` / `ctx.inventoryFull()`.

### API Client (`src/api.mjs`)

HTTP client for all API calls. Auto-retries on cooldown (code 499) and gateway errors. All actions return results with cooldown info — use `waitForCooldown(result)` after every action.

### Bank Operations

- All bank withdrawals/deposits go through `services/bank-ops.mjs` with reservation-aware concurrency control. Never call `api.withdrawBank()` directly.
- Bank travel (tile discovery, teleport potions) is in `services/bank-travel.mjs`.
- Gear ownership tracked in `services/gear-state.mjs` — prevents selling/recycling items assigned to characters or orders.

### Adding a New Routine

1. Create `src/routines/my-routine.mjs` extending `BaseRoutine`
2. Register it in `src/routines/factory.mjs` (`buildRoutines()`)
3. Re-export from `src/routines/index.mjs`
4. Add config entry to `config/characters.json`
5. Implement `updateConfig(cfg)` for hot-reload (patch config fields only, never reset runtime state)

## Configuration

- `config/characters.json` — per-character routine configs with weights, goals, settings. **Hot-reloaded** on save (no restart). Adding/removing routine types still requires restart.
- `config/sell-rules.json` — GE selling whitelist and recycler rules
- `.env` — `ARTIFACTS_TOKEN` (required), `BOT_CONFIG`, `WEBSOCKET_URL` (optional), dashboard settings
- Both config files have companion `.schema.json` validators

## File Conventions

- All source files are `.mjs` (ES modules with explicit extensions in imports)
- Services in `src/services/` are typically singletons or stateless utilities
- Game coordinates and static data live in `src/data/locations.mjs`
- Persistent state files (gear-state, order-board) write to `./report/` with atomic writes
- Item types use slot name directly (e.g., `type: "boots"`), NOT `type: "equipment"` with a subtype

## API Reference

- Local OpenAPI spec: `docs/openapi.json`
- Online docs: https://docs.artifactsmmo.com/
- Live spec: https://api.artifactsmmo.com/openapi.json
