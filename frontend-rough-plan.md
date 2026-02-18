Skill Use
Using the artifacts-mmo skill for runtime/API integration planning around your existing bot loop.

Proposed Implementation Plan

Phase 1: Live Character Cards (first deliverable)
Keep your visual design in mockup-v3d.html, replace mock data with real state.
Add telemetry hooks in context.mjs, scheduler.mjs, log.mjs, and api.mjs.
Add a small dashboard server (same process) with:
GET /api/ui/snapshot (full initial state)
GET /api/ui/events (SSE stream of updates)
UI subscribes to SSE, updates card fields: name, level, HP/XP bars, current task, live log line, cooldown.
Acceptance: cards update within ~1s after bot actions, no browser polling of Artifacts API directly.
Phase 2: Modal Framework + Core Modals
Wire existing card buttons (EQUIP, INVEN, SKILLS, STATS, ACHIEV) to a reusable modal component.
Start with live data from current character snapshot:
Inventory modal from character.inventory
Equipment modal from *_slot fields
Skills modal from *_level/xp/max_xp
Add per-character recent log history buffer (backend ring buffer + modal view).
Phase 3: Achievements + Extended Data
Add API wrappers for account/achievement data in api.mjs (e.g. /my/details, /accounts/{account}/achievements).
Cache achievement responses server-side (TTL) and stream updates to modal.
Add optional modal sections for bank + GE summaries using existing services.
Phase 4: Config UI
Add config endpoints:
GET /api/config
PUT /api/config (validate against characters.schema.json, save atomically)
Build form-based editor for routines/settings per character.
Show validation errors inline before applying.
Phase 5: Bot Control Actions (reload/restart)
Refactor runtime into a controllable BotRuntime manager (start/stop/reload).
Add graceful shutdown support to loops in scheduler.mjs and cooldown waits in api.mjs.
Add control endpoints/buttons:
POST /api/control/reload-config
POST /api/control/restart
Add operation locking + status events so UI shows “reloading/running/error” clearly.
Recommended PR sequence

Runtime telemetry + SSE + live card wiring (Phase 1).

Modal shell + Skills/Inventory/Equipment (Phase 2).

Achievements + extended modal data (Phase 3).

Config editor + validation (Phase 4).

Reload/restart controls + graceful runtime management (Phase 5).

If you want, I can start Phase 1 now and scaffold the server/event pipeline first.

Or I can first extract mockup-v3d.html into a cleaner componentized JS structure before wiring live data.


