# Frontend Runtime Dashboard Orchestration Plan

This document converts `frontend-plan.md` into executable multi-agent packets.
Phase 1 is treated as complete baseline. Execution proceeds Phase 2 -> 3 -> 4 -> 5.

## Global Rules (All Phases)

1. Preserve existing snapshot contract from `/api/ui/snapshot` and `/api/ui/events`.
2. Keep `report/` behavior unchanged.
3. Return structured JSON errors from all new endpoints:
   1. `{ error: string, detail?: string, code?: string }`
4. Use feature-flag style rollout per phase:
   1. New UI controls appear only when corresponding backend endpoints exist.
5. QA gate for each phase:
   1. endpoint contract tests
   2. regression test on existing dashboard endpoints
   3. manual smoke checklist logged in handoff note

## Team Topology Per Phase

1. Team A (Frontend/UI): `frontend/dashboard-phase1.html`
2. Team B (Runtime/API): `src/services/*`, `src/dashboard-server.mjs`, `src/api.mjs`, `src/bot.mjs`
3. Team C (QA/Verification): `scripts/test-*.mjs`

Ownership rule:
1. Teams must not edit each other’s owned files unless explicitly coordinated in handoff.

---

## Phase 2 Detailed Execution Packet

### Objective
Implement modal framework and character detail data flow for Skills, Inventory, Equipment, and Stats.

### Team B (Runtime/API) Tasks
1. Extend UI state store with per-character detail payload source data:
   1. skills map/array from character snapshot fields
   2. inventory slots
   3. equipment slots
   4. gold, position, task summary, log history
2. Add endpoint:
   1. `GET /api/ui/character/:name`
3. Endpoint behaviors:
   1. `404` when character is unknown
   2. return normalized payload:
      1. `identity`
      2. `skills[]`
      3. `inventory[]`
      4. `equipment[]`
      5. `stats`
      6. `logHistory` (cap 50)
      7. `updatedAtMs`
4. Keep `/api/ui/snapshot` payload unchanged for backward compatibility.

### Team A (Frontend/UI) Tasks
1. Add modal host system with one active modal at a time.
2. Enable buttons:
   1. `SKILLS`, `INVEN`, `EQUIP`, `STATS`
3. Keep `ACHIEV` disabled.
4. Add modal state model:
   1. active character
   2. active modal kind
   3. detail fetch status (`idle|loading|ready|error`)
5. Data refresh policy:
   1. fetch detail on modal open
   2. if modal open and snapshot `lastUpdatedAtMs` changes for same character, refetch
6. Accessibility:
   1. `Esc` closes
   2. focus trap
   3. body scroll lock
7. Empty/error rendering:
   1. stale/offline state banners
   2. no-items/no-skills messaging

### Team C (QA) Tasks
1. Add/extend endpoint tests for:
   1. `/api/ui/character/:name` success payload shape
   2. unknown character 404
2. Regression checks for:
   1. `/api/ui/snapshot`
   2. `/api/ui/events` initial snapshot + heartbeat
3. Add modal logic test seams (pure JS helpers where possible) for:
   1. modal open/close transitions
   2. detail refetch trigger decision

### Phase 2 Done Criteria
1. Four modal views render from live detail endpoint.
2. No snapshot contract break.
3. All phase tests pass.

---

## Phase 3 Detailed Execution Packet

### Objective
Add account-level achievements with cached backend fetches and ACHIEV modal UX.

### Team B (Runtime/API) Tasks
1. Add API client methods in `src/api.mjs`:
   1. `getMyDetails()`
   2. `getAccountAchievements(account, params = {})`
2. Add `src/services/account-cache.mjs` with TTL cache:
   1. account details TTL 5 min
   2. achievements TTL 10 min
3. Add dashboard endpoints:
   1. `GET /api/ui/account/summary`
   2. `GET /api/ui/account/achievements`
4. Failure behavior:
   1. structured JSON error
   2. no impact on character snapshot stream

### Team A (Frontend/UI) Tasks
1. Enable `ACHIEV` button.
2. Add achievement modal:
   1. summary totals
   2. filter tabs (`completed`, `in-progress`, `all`)
   3. search by code/title
3. Add loading/empty/error states.
4. Keep existing character modal behavior unchanged.

### Team C (QA) Tasks
1. Cache tests:
   1. miss -> fetch
   2. hit within TTL
   3. expiry refresh
2. Endpoint payload contract tests for summary + achievements.
3. UI filter/search state tests for deterministic helper functions.

### Phase 3 Done Criteria
1. Achievements visible and usable under active SSE traffic.
2. Cache suppresses redundant upstream requests.
3. Character dashboard behavior unchanged.

---

## Phase 4 Detailed Execution Packet

### Objective
Add safe config edit/validate/save workflow with conflict protection.

### Team B (Runtime/API) Tasks
1. Add config endpoints in `src/dashboard-server.mjs`:
   1. `GET /api/config`
   2. `POST /api/config/validate`
   3. `PUT /api/config`
2. Add config service module for:
   1. load active config path (`BOT_CONFIG`)
   2. content hash generation
   3. schema validation against `config/characters.schema.json`
   4. atomic save (`temp` + `rename`)
3. Concurrency control:
   1. reject stale `ifMatchHash` with 409

### Team A (Frontend/UI) Tasks
1. Add Config modal/editor panel:
   1. raw JSON textarea editor
   2. validate action
   3. save action with hash header/body
2. Render validation errors with path + message.
3. Render deterministic save results:
   1. success banner
   2. conflict banner
   3. malformed JSON guardrail

### Team C (QA) Tasks
1. Validation tests:
   1. valid config -> ok true
   2. invalid config -> errors list
2. Atomic save test:
   1. temp file write and rename path behavior
3. Conflict tests:
   1. stale hash -> 409

### Phase 4 Done Criteria
1. Config edits are validated and safely persisted.
2. Invalid payload never overwrites live config.
3. Concurrent edits fail deterministically.

---

## Phase 5 Detailed Execution Packet

### Objective
Add controlled runtime lifecycle operations (reload config, restart) with operation lock.

### Team B (Runtime/API) Tasks
1. Create `src/runtime-manager.mjs`:
   1. lifecycle state machine (`stopped|starting|running|stopping|error`)
   2. operation lock for control actions
   3. methods:
      1. `start()`
      2. `stop(gracefulTimeoutMs)`
      3. `reloadConfig()`
      4. `restart()`
2. Refactor bot startup wiring to use runtime manager.
3. Add endpoints:
   1. `GET /api/control/status`
   2. `POST /api/control/reload-config`
   3. `POST /api/control/restart`
4. Guard behavior:
   1. concurrent operations -> 409
   2. timeout -> structured error state

### Team A (Frontend/UI) Tasks
1. Add control panel with:
   1. Reload Config
   2. Restart Bot
2. Add operation progress states:
   1. pending/in-flight/success/failure
3. Disable control buttons during in-flight operation.

### Team C (QA) Tasks
1. Lifecycle unit tests for runtime manager transitions.
2. Endpoint lock/conflict tests.
3. SSE resilience checks:
   1. client remains stable across restart/reconnect

### Phase 5 Done Criteria
1. Reload/restart operations are serialized and observable.
2. No orphan runtime loops after restart.
3. SSE dashboard recovers after restart.

---

## Execution Sequence and Dependency Gates

1. Execute phases strictly in order: 2 -> 3 -> 4 -> 5.
2. Within each phase:
   1. Team B and Team A run in parallel once contracts are locked.
   2. Team C starts after first mergeable deltas from A/B.
3. Merge gate:
   1. Team C tests pass
   2. endpoint contract checklist signed
   3. manual smoke notes captured

## Handoff Template (Per Phase)

1. Scope completed
2. Files touched
3. Interfaces added/changed
4. Test results (command + pass/fail)
5. Manual checklist results
6. Residual risks
