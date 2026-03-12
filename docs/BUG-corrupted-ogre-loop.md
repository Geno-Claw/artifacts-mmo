# Bug Report: Corrupted Ogre Order Loop

**Date**: 2026-03-12
**Affected Character**: GenoClaw2 (observed), potentially any character
**Severity**: Medium — causes infinite resource-wasting loop (travel, food, cooldowns)
**Status**: Diagnosed, not yet fixed

---

## Summary

GenoClaw2 gets stuck in an infinite loop: claiming a `corrupted_skull` order → trying to farm `corrupted_gem` from `corrupted_ogre` → failing → re-claiming. The loop burns travel cooldowns, food, and prevents the character from doing any useful work.

## Root Cause Chain

The bug is actually **three independent issues** compounding into one visible loop.

---

### Bug 1: Stale Monster Location Cache

**File**: `src/services/game-data.mjs` (line ~767)

**What happens**: `getMonsterLocation()` caches the first successful map lookup forever (in-memory, never TTL'd). When a `corrupted_ogre` event was active earlier in this bot session, the maps API returned event tiles at `(8,-4)`. That result is now cached even though the event ended and the maps API returns empty for `corrupted_ogre`.

**Why it matters**: The order fulfillment code at `order-claims.mjs:1282` calls `getMonsterLocation('corrupted_ogre')`, gets the stale `{x:8, y:-4}` from cache, and happily sends the character there. Without this stale cache, it would get `null` and correctly trigger `missing_fight_location`, blocking the claim.

**Evidence**:
```
# Maps API returns nothing for corrupted_ogre (no permanent spawn)
GET /maps?content_type=monster&content_code=corrupted_ogre → { data: [], total: 0 }

# But the bot keeps traveling to (8,-4) — a location from a past event
[21:25:59] [GenoClaw2] Moving (4,1) → (8,-4)
[21:27:25] [GenoClaw2] Moving (8,-4) → (4,1)
```

**Suggested fixes** (pick one or combine):

**A) TTL the monster location cache**
Add a timestamp to cached entries and expire them after N minutes (e.g., 10-15 min). On expiry, re-query the maps API. This is the most general fix — handles any map content that changes over time.

```js
// Example sketch
const CACHE_TTL_MS = 10 * 60_000; // 10 minutes
monsterLocationCache[monsterCode] = { x: tile.x, y: tile.y, cachedAt: Date.now() };

// On lookup:
if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
delete monsterLocationCache[monsterCode]; // expired, re-fetch
```

**B) Invalidate cache on event end**
In `event-manager.mjs`, when an event despawns (`removeEvent`), call `gameData.markLocationUnreachable('monster', code)` or directly delete the cache entry. This is more targeted but requires the event manager to know about the location cache.

**C) Never cache event-only monsters**
Before caching in `getMonsterLocation`, check if the monster has no permanent map tiles (i.e., the result came from an event tile). Skip caching for these. Tricky to detect reliably since the maps API doesn't distinguish event vs permanent tiles.

**Recommended**: Option B is cleanest — event manager already tracks despawns and `markLocationUnreachable` already exists.

---

### Bug 2: No Circuit Breaker on NPC-Buy Fight Loop

**File**: `src/routines/skill-rotation/order-claims.mjs` (line ~1296) + `src/services/food-manager.mjs` (line ~216)

**What happens**: The order execution flow for NPC-buy claims with fight prerequisites goes:

1. `canClaimNpcBuyOrderNow()` (line ~440) — runs combat sim, **passes** (the sim says GC2 can beat corrupted_ogre at full HP with optimal gear)
2. Claim is accepted, execution begins
3. `_equipForCraftFight()` (line ~1288) — equips gear, sim passes again
4. `getFightReadiness()` (line ~1296) — checks current HP vs required HP
5. HP check: needs ~701hp (84% of 840 max), character has ~408hp
6. `restUntil()` is called — eats available food (a few apples), but can't reach threshold
7. Returns `status: 'needs_rest'` (NOT `'unwinnable'`)
8. Caller returns `{ reason: 'waiting_for_rest' }` — claim is NOT blocked
9. Routine yields, next cycle re-claims, repeat forever

The critical gap: `'needs_rest'` is treated as a temporary condition ("try again later"), but in practice the character can never reach the HP threshold because:
- They don't have enough food in inventory
- The rest routine can only eat what's on hand + use the API rest action
- After resting + eating, they travel to (8,-4), which consumes a cooldown, then back to bank — burning time without progress

**Evidence**:
```
[20:27:52] [GenoClaw2] Need 714hp (85%) to fight corrupted_ogre, have 377hp
[20:31:19] [GenoClaw2] Need 701hp (84%) to fight corrupted_ogre, have 408hp
[20:34:58] [GenoClaw2] Need 701hp (84%) to fight corrupted_ogre, have 408hp
[20:38:06] [GenoClaw2] Need 701hp (84%) to fight corrupted_ogre, have 470hp
[20:41:07] [GenoClaw2] Need 701hp (84%) to fight corrupted_ogre, have 408hp
... (continues for hours)
```

**Suggested fixes**:

**A) Count consecutive rest failures per monster**
Track how many times `getFightReadiness` returns `needs_rest` for the same monster within the same claim. After N failures (e.g., 3), escalate to `unwinnable` and block the claim.

```js
// In the fight step execution (order-claims.mjs ~1296):
if (readiness.status === 'needs_rest') {
  ctx.recordRestFailure(monsterCode);
  if (ctx.consecutiveRestFailures(monsterCode) >= 3) {
    await routine._blockAndReleaseClaim(ctx, `rest_threshold_unreachable:${monsterCode}`);
    return { attempted: false, fulfilled: false, reason: 'rest_threshold_unreachable' };
  }
  return { attempted: false, fulfilled: false, reason: 'waiting_for_rest' };
}
// Clear on successful fight:
ctx.clearRestFailures(monsterCode);
```

**B) Pre-check food availability before claiming**
In `canClaimNpcBuyOrderNow`, after the sim check passes, also verify the character has enough healing (food in inventory + bank) to reach the required HP threshold. If not, skip the claim.

**C) Block claim when `restUntil` fails to reach target**
In `getFightReadiness` (food-manager.mjs ~299), when `restUntil` returns false and HP is still below threshold, return `'unwinnable'` instead of `'needs_rest'`. This is the simplest fix but might be too aggressive — there are legitimate cases where resting on the next tick would work (e.g., natural HP regen between ticks).

**Recommended**: Option A — adds a retry limit without changing the semantics of `needs_rest` for other callers.

---

### Bug 3: Order Planner Doesn't Filter Event-Only Monsters

**File**: `src/services/game-data.mjs` (line ~638) + `src/routines/skill-rotation/order-claims.mjs`

**What happens**: When the order planner resolves the NPC-buy plan for `corrupted_skull`, it finds that `corrupted_gem` is needed as currency. It looks up `corrupted_gem` in the drop-to-monster reverse cache and finds `corrupted_ogre`. It adds a fight step to the plan without checking whether `corrupted_ogre` has any permanent map presence.

The API lists `corrupted_ogre` as `type: "normal"` (level 20), but it has **zero permanent map tiles**. It only spawns during events. The monster type field doesn't distinguish between permanent and event-only monsters.

**Evidence**:
```
GET /monsters/corrupted_ogre → { type: "normal", level: 20 }
GET /maps?content_type=monster&content_code=corrupted_ogre → { data: [], total: 0 }

# Same pattern for corrupted_owlbear:
GET /monsters/corrupted_owlbear → { type: "normal", level: 30 }  
GET /maps?content_type=monster&content_code=corrupted_owlbear → { data: [], total: 0 }
```

**Suggested fixes**:

**A) Check map availability when building NPC-buy plans**
In `game-data.mjs` at the fight step resolution (line ~645), after finding the monster for a drop, verify it has a permanent map location. If not, don't add the fight step — treat the item as unobtainable via combat.

```js
// In the resolve() function, after finding monsterDrop:
const monsterDrop = getMonsterForDrop(mat.code);
if (monsterDrop) {
  const loc = await getMonsterLocation(monsterDrop.monster.code);
  if (!loc) continue; // Skip — monster has no permanent spawn
  steps.push({ type: 'fight', ... });
  continue;
}
```

**Caveat**: This makes `resolve()` async (if it isn't already) and adds an API call per fight step. Could cache "no-location" results.

**B) Maintain a blocklist of event-only monsters**
Less elegant but simple. Hardcode or derive from the events API which monster codes are event-only (have event definitions but no permanent map tiles). Filter them out during plan building.

**C) Check at claim time instead of plan time**
In `canClaimNpcBuyOrderNow`, after building the plan, check `getMonsterLocation` for each fight step. If any returns null, reject the claim. This is where Bug 1's stale cache interferes — if the cache has a stale entry, this check would pass incorrectly. So this fix depends on Bug 1 being fixed first.

**Recommended**: Option A (with caching) is the most robust. Option C is a good secondary check but requires Bug 1's fix to be reliable.

---

## Interaction Between Bugs

The three bugs create a perfect storm:

```
Bug 3: Plan includes fight step for corrupted_ogre (event-only monster)
  ↓
Bug 1: Stale cache provides location (8,-4) from a past event
  ↓  
  (Without stale cache, getMonsterLocation returns null → claim blocked → loop stops)
  ↓
Bug 2: HP readiness check fails but doesn't block the claim
  ↓
  Character loops: bank → (8,-4) → bank → (8,-4) → ...
```

Fix **any one** of these and the visible loop stops. Fix all three for proper defense in depth.

## Immediate Mitigation

Until code fixes are deployed, options:
1. Restart the bot service (clears in-memory caches including stale monster locations)
2. Add `corrupted_skull` to a blocked-items list in character config (if one exists)
3. Manually cancel the order board entry for corrupted_skull

## Affected Monsters (known event-only with `type: "normal"`)

| Monster | Level | Has Permanent Map Tiles | Drops |
|---------|-------|------------------------|-------|
| corrupted_ogre | 20 | ❌ No | corrupted_gem, ogre_eye, ogre_skin |
| corrupted_owlbear | 30 | ❌ No | corrupted_gem, owlbear_hair, owlbear_claw |
| efreet_sultan | 42 | ❌ (elite) | — |
| grimlet | 45 | ❌ (elite) | — |

Any item whose only source is a drop from these monsters is vulnerable to the same loop.
