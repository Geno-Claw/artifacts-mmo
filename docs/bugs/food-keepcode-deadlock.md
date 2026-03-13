# Bug Report: Food Keep-Code Inventory Deadlock

**Severity:** High (character permanently stuck until manual intervention)
**Affected:** Any character with `foodRefill.enabled: true` + limited `inventory_max_items`
**Discovered:** 2026-03-13, GenoClaw5 stuck for 4+ hours

---

## Summary

A character can enter an unrecoverable deadlock where **every routine** returns `canRun: false` because:

1. Food withdrawal fills inventory to capacity (quantity count)
2. Keep-codes protect that food from being deposited
3. `inventoryFull()` blocks all routines, including the one that would clear keep-codes

## Reproduction

1. Character has `foodRefill.enabled: true`
2. Order Fulfillment (or combat in Skill Rotation) withdraws food for fights
3. `withdrawFoodForFights()` / `withdrawBulkFood()` fills available space and registers keep-codes via `ctx.setRoutineKeepCodes()`
4. Routine completes (e.g. order fulfillment finishes, or skill rotation yields due to "conditions changed")
5. On next scheduler tick:
   - **Skill Rotation** `canRun()` → `ctx.inventoryFull()` → `true` (153 trout + 16 other items = 169 = capacity) → **blocked**
   - **Deposit Bank** `canRun()` → `_countDepositableInventory()` → trout protected by keep-codes → `depositableCount = 0` → **blocked**
   - **All other routines** → either check `inventoryFull()` or have other conditions unmet → **blocked**
6. `clearRoutineKeepCodes()` only runs inside `Skill Rotation.execute()` (line 115) and `Order Fulfillment.execute()` (line 131) — but neither `execute()` is ever called because `canRun()` fails first.

**Result:** Infinite `"No runnable routines - idling 30s"` loop.

## Root Cause

The keep-code lifecycle has a **circular dependency**:

```
clearRoutineKeepCodes() → called inside execute()
execute() → only called if canRun() passes
canRun() → fails because inventoryFull()
inventoryFull() → true because food is hogging capacity
deposit won't remove food → because keep-codes protect it
keep-codes persist → because clearRoutineKeepCodes() never runs
```

## Evidence (GenoClaw5, 2026-03-13)

```
Inventory: 169/169 capacity (8 unique slots used out of ~20 available)
  cooked_trout x153  ← food, protected by keep-codes
  coal x10, piggy_helmet x1, old_boots x1, forest_ring x1,
  fishing_net x1, mushmush_jacket x1, steel_legs_armor x1

Scheduler scan (every routine runnable=false):
  Rest:false, Event:false, Deposit:false, BankExpansion:false,
  CompleteTask:false, BossFight:false, OrderFulfillment:false,
  SkillRotation:false
```

Stuck from ~13:12 UTC until bot stopped at 17:10 UTC (4 hours idle).

---

## Proposed Fixes

### Fix 1: Clear keep-codes on routine transition (RECOMMENDED)

Clear keep-codes in the **scheduler** when a routine finishes, not inside the next routine's `execute()`.

**File:** `src/scheduler.mjs`

```js
// After a routine's execute() completes or when transitioning between routines:
if (typeof this.ctx.clearRoutineKeepCodes === 'function') {
  this.ctx.clearRoutineKeepCodes();
}
```

This breaks the circular dependency — keep-codes are always cleaned up between routines regardless of which routine runs next.

**Pros:** Simple, correct, prevents the entire class of deadlocks
**Cons:** Food might get deposited during a deposit-bank run between two combat-oriented routines (minor efficiency loss, not correctness)

### Fix 2: Deposit Bank ignores keep-codes when inventory is at capacity

Add an escape hatch in `deposit-bank.mjs` `canRun()`:

```js
canRun(ctx) {
  // Emergency: if inventory is at capacity and we have depositable items
  // ignoring keep-codes, force a deposit to break deadlocks
  if (ctx.inventoryFull()) {
    const totalDepositable = this._countDepositableInventory(ctx, {}); // no keep-codes
    if (totalDepositable > 0) return true;
  }
  // ... existing logic
}
```

And in `execute()`, when inventory is full, deposit with relaxed keep-codes.

**Pros:** Self-healing, doesn't require scheduler changes
**Cons:** More complex, deposit might bank food that's still needed

### Fix 3: Cap food withdrawal to leave headroom

In `withdrawBulkFood()` and `withdrawFoodForFights()`, don't fill to capacity:

```js
// Current:
const DROP_RESERVE = 8;

// Proposed: reserve a percentage of capacity, not just a flat count
const DROP_RESERVE = Math.max(8, Math.floor(ctx.inventoryCapacity() * 0.15));
```

**Pros:** Prevents the condition from occurring
**Cons:** Doesn't fix the root cause — keep-code lifecycle is still broken. Lower-capacity characters would carry less food.

### Fix 4: `inventoryFull()` awareness in Skill Rotation's `canRun()`

If inventory is full but it's *only* because of food (keep-coded items), let the routine run so it can clear keep-codes and trigger a deposit:

```js
canRun(ctx) {
  if (!this.enabled) return false;
  if (ctx.inventoryFull()) {
    // Allow running if keep-codes are the reason we're "full"
    // execute() will clear them and yield for deposit
    const keepTotal = Object.values(ctx.getRoutineKeepCodes() || {})
      .reduce((sum, n) => sum + n, 0);
    if (keepTotal > 0) return true;
    return false;
  }
  return true;
}
```

**Pros:** Targeted fix for skill rotation specifically
**Cons:** Doesn't fix other routines that also check `inventoryFull()`

---

## Recommendation

**Apply Fix 1 (scheduler-level clear) as the primary fix** — it's the simplest and most correct. The keep-code lifecycle should be owned by the scheduler, not scattered across individual routines.

Optionally combine with **Fix 3** (capacity headroom) as defense-in-depth to reduce unnecessary food hoarding on low-capacity characters.

## Immediate Workaround

Hit the API directly to deposit the trout:
```bash
curl -X POST "https://api.artifactsmmo.com/my/GenoClaw5/action/bank/deposit" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code": "cooked_trout", "quantity": 140}'
```
