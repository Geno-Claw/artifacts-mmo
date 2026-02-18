# Inventory Manager Plan (Phase 1 + Phase 2.5)

## Objective

Use `InventoryManager` as the single source of truth for:

- Bank quantities
- Per-character inventory/equipment state
- Concurrent bank access safety (reservations)

This prevents stale-bank races, recycler over-recycle behavior, and gear swap conflicts.

## Phase 1 (Completed)

### Delivered

1. Added `src/services/inventory-manager.mjs` with:
   - bank cache (`getBankItems`, `invalidateBank`, `applyBankDelta`)
   - character mirrors (`updateCharacter`, inventory/equipment rebuild)
   - global counting (`bankCount`, `inventoryCount`, `equippedCount`, `globalCount`)
2. Wired startup/refresh:
   - `bot.mjs` calls `initialize()`
   - `context.mjs` refresh path calls `updateCharacter()`
3. Converted bank source of truth to inventory manager-backed reads.
4. Added mutation hooks on successful bank withdraw/deposit flows.
5. Fixed recycler surplus calc to use `globalCount(code)` then cap by bank.
6. Added deterministic script harness `scripts/test-inventory-manager.mjs`.

### Acceptance checks

- No negative bank counts after deltas
- Bank count updates immediately after withdraw/deposit
- Recycler considers equipped + carried items (not bank-only)

## Phase 2 (Completed): Reservations and Contention Hardening

### Scope

Add a lightweight reservation layer so planned withdrawals are visible to other characters before API withdraw execution.

### API surface (Inventory Manager)

1. `availableBankCount(code, { includeChar })`
2. `reserve(code, qty, charName, ttlMs?)`
3. `reserveMany(requests, charName, ttlMs?)` (atomic by aggregated code)
4. `release(reservationId)`
5. `releaseAllForChar(charName)`
6. `cleanupExpiredReservations()`
7. `snapshot()` includes reservation state

### Core behavior

1. Reservations are TTL-bound (default 30s).
2. Expired reservations are cleaned before availability checks.
3. `availableBankCount` excludes other chars’ reservations but can include caller reservations.
4. `reserveMany` fails atomically if any code is short.
5. `withdrawItem` always releases reservation in `finally`.

### Integration points delivered

1. `src/helpers.mjs`
   - `withdrawItem`: reservation-aware single withdraw
   - `withdrawPlanFromBank`: batch reserve with per-item fallback
   - `withdrawFoodForFights`: uses reservation-aware withdraw path
   - `equipForCombat`/`equipForGathering`: reserve needed bank pulls before swaps
2. `src/services/ge-seller.mjs`
   - availability-aware withdrawal checks
3. `src/services/recycler.mjs`
   - availability-aware withdrawal checks

## Phase 2.5 (Completed): Universal Reservation-Backed Withdrawals

### Delivered

1. Added `src/services/bank-ops.mjs` as the **single item-withdraw service**.
2. Added shared APIs:
   - `withdrawBankItem(ctx, code, quantity = 1, opts = {})`
   - `withdrawBankItems(ctx, requests, opts = {})`
3. Implemented shared defaults:
   - partial fill mode
   - one forced refresh retry on stale/availability contention
   - batch reservation with per-item reservation fallback
4. Rewired all item-withdraw callers:
   - `helpers.mjs`
   - `ge-seller.mjs`
   - `recycler.mjs`
5. Removed recycler flow mutex (`_recycleLock`) and kept GE flow mutex (`_sellLock`).
6. Added deterministic harness `scripts/test-bank-ops.mjs`.

### Validation

Run:

```bash
npm run -s test:inventory-manager
npm run -s test:bank-ops
```

Current harness covers:

1. reservation availability math (`includeChar` behavior)
2. atomic `reserveMany` success/failure
3. release + expiry cleanup paths
4. bank delta clamping and refetch invalidation
5. in-flight fetch dedupe

## Remaining follow-up (Phase 3)

1. Crash-safety:
   - call `releaseAllForChar(charName)` on character loop shutdown/restart.
2. Observability:
   - add periodic reservation metrics (`active`, `expired cleaned`, `reserveMany fail reason`).
3. Tuning:
   - evaluate reservation TTL by observing slow-path actions.

## Risks / gotchas to watch

1. Long action chains can outlive TTL and release effective protection.
2. `applyBankDelta` correctness depends on only applying after confirmed API success.

## Success criteria

1. No duplicate withdrawals caused by same-tick bank contention.
2. No recycler over-recycle of items equipped/carried by other characters.
3. Gear swaps fail safe (skip slot) when bank availability changes mid-flow.
4. Polling profile stays near Phase 1 baseline (no meaningful API increase).
