# Logging Guide

## Purpose

The runtime logging system is designed to answer:

1. What decision was made.
2. Why it was made.
3. Which routine/action caused it.
4. What interrupted what.
5. What the outcome/error was.

## Outputs and Configuration

Logging is controlled with environment variables:

- `LOG_LEVEL` (default: `info`)
  - Allowed: `debug`, `info`, `warn`, `error`, `stat`
- `LOG_OUTPUT` (default: `console,jsonl`)
  - Comma-separated sinks: `console`, `jsonl`
- `LOG_DIR` (default: `./report/logs`)
  - JSONL target directory
- `LOG_DEBUG_SCOPES` (optional)
  - Comma-separated scope allowlist for debug logs (for example: `scheduler,api,cooldown`)

Daily JSONL files are written to:

- `./report/logs/runtime-YYYY-MM-DD.jsonl`

Sink failures are non-fatal and must never crash the runtime.

## Logger API

`src/log.mjs` supports both compatibility and structured calls:

- Compatibility:
  - `log.info(message)`
  - `log.warn(message)`
  - `log.error(message, detailOrMeta)`
- Structured:
  - `const logger = createLogger(baseContext)`
  - `logger.info(message, meta)`
  - `logger.child(extraContext)`

`meta` supports:

- `scope`
- `event`
- `reasonCode`
- `context` (merged with async log context)
- `data` (sanitized and size-capped)
- `error`

## Context Propagation

`src/log-context.mjs` carries correlation fields across async boundaries using `AsyncLocalStorage`:

- `runWithLogContext(ctx, fn)`
- `getLogContext()`

Common context fields:

- `character`
- `routine`
- `runId`
- `tickId`
- `traceId`
- `requestId`
- `action`
- `operation`

## Canonical Entry Shape

Each emitted entry includes:

- `atMs`
- `iso`
- `level`
- `message`
- `scope`
- `event`
- `reasonCode`
- `context`
- `data`
- `error`

Compatibility fields are also retained:

- `line`
- `msg`
- `at`

## Severity Policy

- `error`: operation failed and needs intervention or indicates incorrect behavior.
- `warn`: degraded behavior or fallback path taken.
- `info`: lifecycle transitions, selected actions, successful milestones.
- `debug`: decision traces, skip reasons, candidate evaluations, cooldown internals.

## Reason Codes

Current first-set taxonomy:

- Scheduler:
  - `no_runnable_routine`
  - `routine_conditions_changed`
  - `preempted_by_higher_priority`
  - `loop_stop_requested`
- Routine decisions:
  - `inventory_full`
  - `hp_below_threshold`
  - `event_expired`
  - `event_on_cooldown`
  - `no_path`
  - `insufficient_skill`
  - `unwinnable_combat`
  - `bank_unavailable`
- API/retry:
  - `cooldown_499_retry`
  - `gateway_retry`
  - `network_retry`
  - `request_failed`
- Yield/interruption:
  - `yield_for_rest`
  - `yield_for_deposit`
  - `yield_for_preemption`
  - `yield_for_backoff`

## Dashboard Troubleshooting

### Character timeline reconstruction

Use:

1. `runId` to isolate runtime session.
2. `tickId` to follow scheduler loop progression.
3. `requestId` to correlate API request lifecycle with cooldown wait and action outcomes.

### Interruption analysis

Use filtered logs or the interruption timeline section:

- `event = routine.preempted` to see source routine vs interrupting routine.
- `event = routine.yield` plus `reasonCode` to see why routines yielded.

### API retry debugging

Filter by:

- `scope = api`
- `event in api.request.retry|api.request.fail|cooldown.wait.*`

Then follow the shared `requestId`.

## Dashboard Endpoints

- Character detail:
  - `GET /api/ui/character/:name`
- Filtered logs:
  - `GET /api/ui/character/:name/logs?level=&scope=&event=&reasonCode=&limit=&beforeAt=`
