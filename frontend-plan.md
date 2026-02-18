# Frontend Runtime Dashboard Master Implementation Plan (Agent Handoff Edition)

## Summary
This document is the master handoff plan for the live frontend dashboard program. It defines the full phased rollout, clear boundaries for parallel agents, stable interfaces, test gates, and acceptance criteria so each phase can be implemented without further product decisions.

Document target path: `docs/frontend-runtime-dashboard-master-plan.md`  
Current baseline: Phase 1 runtime card streaming is implemented and test-covered.  
Execution model: Phase-by-phase delivery with explicit handoff packets per phase.

## Phase Highlights
| Phase | Focus | Outcome | Status |
|---|---|---|---|
| Phase 1 | Live character cards | Real-time cards from bot runtime via SSE | Completed baseline |
| Phase 2 | Modal framework + core modals | Skills, Inventory, Equipment, Stats from runtime | Next |
| Phase 3 | Achievements + extended account data | Achievement modal and account-level progress | Planned |
| Phase 4 | Config UI | Edit/validate/save bot config safely | Planned |
| Phase 5 | Runtime controls | Reload config and controlled restart from UI | Planned |

## Current Baseline (What Exists)
1. Runtime UI state service exists in `src/services/ui-state.mjs`.
2. Dashboard server exists in `src/dashboard-server.mjs` with:
   1. `GET /`
   2. `GET /api/ui/snapshot`
   3. `GET /api/ui/events`
   4. `GET /healthz`
3. Bot startup wires telemetry and dashboard in `src/bot.mjs`.
4. Frontend runtime page exists at `frontend/dashboard-phase1.html`.
5. Tests exist:
   1. `scripts/test-ui-state.mjs`
   2. `scripts/test-dashboard-server.mjs`
6. Existing `report` server and static dashboard path remain separate and untouched.

## Stable Interface Contracts

### 1. Snapshot Stream Contract (keep stable across phases)
`GET /api/ui/snapshot` and SSE `snapshot` events must keep these top-level keys:
1. `serverTimeMs`
2. `configPath`
3. `startedAtMs`
4. `characters[]`

Each `characters[]` item must keep:
1. `name`
2. `portraitType`
3. `status`
4. `stale`
5. `lastUpdatedAtMs`
6. `level`
7. `hp`, `maxHp`
8. `xp`, `maxXp`
9. `position`
10. `routine`
11. `cooldown`
12. `task`
13. `logLatest`
14. `logHistory`

### 2. New Contract for Modal Data (introduced in Phase 2)
Add `GET /api/ui/character/:name` with payload:
1. `identity`: name, status, stale, level
2. `skills`: normalized array with `code`, `level`, `xp`, `maxXp`, `pct`
3. `inventory`: normalized array with `code`, `quantity`, `slotIndex`
4. `equipment`: normalized array with `slot`, `code`, `quantity`
5. `stats`: hp/maxHp, xp/maxXp, gold, position, task fields
6. `logHistory`: last 50 entries
7. `updatedAtMs`

### 3. Config API Contract (introduced in Phase 4)
1. `GET /api/config` returns `{ path, hash, config }`
2. `POST /api/config/validate` accepts `{ config }`, returns `{ ok, errors[] }`
3. `PUT /api/config` accepts `{ config, ifMatchHash }`, returns `{ ok, hash, savedAtMs }`

### 4. Control API Contract (introduced in Phase 5)
1. `GET /api/control/status` returns lifecycle status
2. `POST /api/control/reload-config`
3. `POST /api/control/restart`

## Multi-Agent Handoff Model

### Agent Packet A (Frontend/UI)
Scope:
1. Modal shell framework
2. Modal rendering logic
3. UI state transitions and empty/error states
4. Accessibility keyboard behavior and focus trap

Primary files:
1. `frontend/dashboard-phase1.html` (or split JS modules under `frontend/`)
2. Optional CSS extraction if needed

Deliverables:
1. Modal framework with deterministic open/close
2. Core modal views in Phase 2
3. UI integration tests for modal behavior

### Agent Packet B (Runtime/API)
Scope:
1. Extend `ui-state` shape for modal-level detail
2. Add `GET /api/ui/character/:name`
3. Add account/achievement fetch + cache in Phase 3
4. Add config/control routes in Phases 4-5

Primary files:
1. `src/services/ui-state.mjs`
2. `src/dashboard-server.mjs`
3. `src/api.mjs`
4. `src/bot.mjs`
5. New service modules as needed

Deliverables:
1. Backward-compatible snapshot stream
2. New read endpoints and cache logic
3. Control/config APIs with validation and locking

### Agent Packet C (QA/Verification)
Scope:
1. Contract tests for new endpoints
2. SSE behavior tests
3. Runtime safety tests for control/config flows
4. Regression test suite orchestration

Primary files:
1. `scripts/test-*.mjs`
2. Optional browser integration scripts

Deliverables:
1. Added automated tests per phase
2. Smoke and failure-mode checklists
3. Release gate report per phase

## Phase-by-Phase Decision-Complete Plan

## Phase 2: Modal Framework + Core Modals

### Goal
Add modal UX for Skills, Inventory, Equipment, and Stats without changing runtime control behavior.

### Implementation
1. Add modal host and overlay components in `frontend/dashboard-phase1.html`.
2. Keep card buttons enabled for UI only:
   1. `SKILLS` -> skills modal
   2. `INVEN` -> inventory modal
   3. `EQUIP` -> equipment modal
   4. `STATS` -> stats modal
   5. `ACHIEV` stays disabled until Phase 3
3. Add backend endpoint `GET /api/ui/character/:name` in `src/dashboard-server.mjs`.
4. Extend `ui-state` to retain details for each character refresh:
   1. inventory slots
   2. equipment slots
   3. skill stats map
   4. gold and position
5. Use pull-on-open + version refresh strategy:
   1. On modal open: fetch detail endpoint once
   2. On incoming snapshots: if `lastUpdatedAtMs` changed for that character and modal is open, refetch detail
6. Log panel in modals uses `logHistory` from detail endpoint (50 entries cap).
7. Accessibility defaults:
   1. `Esc` closes modal
   2. focus trap inside modal
   3. body scroll lock while open

### Testing
1. Unit tests for detail normalization.
2. Endpoint test for `/api/ui/character/:name` and 404 behavior.
3. Frontend tests for open/close/focus-trap.
4. Manual tests:
   1. rapid modal open/close
   2. switching characters while modal open
   3. stale/offline character modal rendering

### Acceptance Criteria
1. Four modals render accurate live data.
2. No card update regressions.
3. No console errors under frequent updates.
4. Snapshot stream remains backward compatible.

## Phase 3: Achievements + Extended Account Data

### Goal
Add account-level progression and achievement visibility.

### Implementation
1. Add API wrappers in `src/api.mjs`:
   1. `getMyDetails()`
   2. `getAccountAchievements(account, params)`
2. Add `src/services/account-cache.mjs` with TTL cache:
   1. details TTL = 5 min
   2. achievements TTL = 10 min
3. Add dashboard endpoints:
   1. `GET /api/ui/account/summary`
   2. `GET /api/ui/account/achievements`
4. Enable `ACHIEV` button to open achievements modal.
5. Achievement modal features:
   1. total completed / total available
   2. filter: completed / in-progress
   3. basic search by code/title

### Testing
1. Cache hit/miss and expiry tests.
2. Endpoint payload shape tests.
3. Modal rendering tests for empty and large datasets.
4. Manual tests for API failure fallback messaging.

### Acceptance Criteria
1. Achievement data available without disrupting character stream.
2. Cache prevents repeated expensive account calls.
3. ACHIEV modal remains usable under stream traffic.

## Phase 4: Config UI

### Goal
Enable safe in-dashboard editing and saving of character config.

### Implementation
1. Add config endpoints in `src/dashboard-server.mjs`:
   1. `GET /api/config`
   2. `POST /api/config/validate`
   3. `PUT /api/config`
2. Validate config against `config/characters.schema.json`.
3. Save strategy:
   1. write to temp file in same directory
   2. atomic rename to target config path
4. Add optimistic concurrency:
   1. client sends `ifMatchHash`
   2. server rejects stale edits with 409
5. Build config editor UI:
   1. raw JSON editor first
   2. inline validation errors with path and message
   3. save confirmation and result banner
6. No implicit runtime reload in this phase.

### Testing
1. Validation pass/fail tests with schema errors.
2. Save atomicity tests (temp + rename).
3. Hash mismatch conflict test.
4. Manual tests for malformed JSON and concurrent edit behavior.

### Acceptance Criteria
1. Config can be validated and saved safely.
2. Invalid config never overwrites existing valid file.
3. User gets deterministic conflict/error feedback.

## Phase 5: Runtime Controls

### Goal
Enable controlled runtime operations from UI.

### Implementation
1. Introduce runtime lifecycle manager (new module `src/runtime-manager.mjs`).
2. Refactor bot startup to lifecycle model:
   1. `start()`
   2. `stop(gracefulTimeoutMs)`
   3. `reloadConfig()`
   4. `restart()`
3. Add control endpoints:
   1. `GET /api/control/status`
   2. `POST /api/control/reload-config`
   3. `POST /api/control/restart`
4. Add operation lock:
   1. single in-flight control action at a time
   2. 409 for concurrent control requests
5. UI controls:
   1. Reload Config button
   2. Restart Bot button
   3. operation progress state and result toast
6. Safety defaults:
   1. graceful stop timeout = 30s
   2. forced cancel after timeout with clear error status

### Testing
1. Lifecycle unit tests for state transitions.
2. Endpoint tests for lock and conflict handling.
3. Manual tests:
   1. reload during active combat cooldown
   2. restart while SSE clients connected
   3. failure path when config invalid on reload

### Acceptance Criteria
1. Reload and restart are predictable and observable.
2. No orphan loop processes after restart.
3. SSE clients recover after restart.

## Cross-Phase Quality Gates
1. Keep `npm run dev` and `npm start` behavior stable.
2. No changes to static `report` server behavior unless explicitly scoped.
3. No direct token exposure in frontend code.
4. All new API routes return structured JSON error bodies.
5. Each phase requires:
   1. contract test updates
   2. manual smoke checklist
   3. brief handoff note for next phase agent

## Recommended Execution Order for Parallel Agents
1. Phase 2:
   1. Agent B builds `/api/ui/character/:name`
   2. Agent A builds modal shell and hooks
   3. Agent C adds tests and integration checks
2. Phase 3:
   1. Agent B builds account cache + endpoints
   2. Agent A adds ACHIEV modal
   3. Agent C validates cache and failure scenarios
3. Phase 4:
   1. Agent B builds config endpoints + schema validation
   2. Agent A builds config UI
   3. Agent C tests save/conflict/error flows
4. Phase 5:
   1. Agent B builds runtime manager + control endpoints
   2. Agent A adds control UX
   3. Agent C validates lifecycle and SSE resilience

## Agent Handoff Checklist Template (use per phase)
1. Scope statement and non-goals.
2. Files touched list.
3. Interface changes list.
4. Test evidence:
   1. command output summary
   2. manual validation checklist
5. Known risks and follow-up items.
6. Compatibility notes for next phase agent.

## Assumptions and Defaults
1. Runtime dashboard remains unauthenticated on trusted LAN/Tailscale unless explicitly changed later.
2. Dashboard continues on port `8091` by default.
3. Existing snapshot SSE model remains the primary real-time transport.
4. `frontend/dashboard-phase1.html` remains the base runtime page through Phase 3.
5. Config editing targets active `BOT_CONFIG` path.
6. No destructive runtime controls beyond reload and restart in this roadmap.
