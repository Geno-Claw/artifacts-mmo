# Artifacts MMO — Item Task & Orderboard Fixes Plan

## Session Date: 2026-02-19

---

## 1. Findings

### 1.1 Map Layers & Transitions

The game has **3 map layers**: `overworld`, `underground`, `interior`.

Characters move between layers using the **Transition API** (`POST /my/{name}/action/transition`). You must be standing on a tile that has a transition available.

**19 transition points exist**, including:
- `(-2,6)` overworld ↔ underground (free, no conditions)
- `(-4,18)` overworld ↔ underground (free)
- `(9,7)` overworld → underground (costs `lich_tomb_key` x1)
- `(0,13)` overworld → interior (requires `cultist_cloak` equipped/has_item)
- `(-3,19)` overworld → interior (costs `sandwhisper_key` x1)
- `(2,16)` overworld → overworld teleport (costs 1000 gold)
- `(7,20)`, `(9,20)` overworld ↔ interior (free)

**Underground resources:**
| Location | Resource | Level |
|----------|----------|-------|
| (-3,4), (-2,5) | mithril_rocks | 40 |
| (-5,18), (-4,19) | adamantite_rocks | 50 |

These are reachable via transitions at (-2,6) and (-4,18) respectively.

### 1.2 Event System

The `/events` endpoint lists **16 event types**. Events spawn temporarily on specific map tiles.

**Event resources** (type=resource):
- `magic_tree` — from `magic_apparition` event (rate: 2000s, duration: 60s)
- `strange_rocks` — from `strange_apparition` event (rate: 2000s, duration: 60s)

**Event monsters** (type=monster):
- `sea_marauder`, `bandit_lizard`, `corrupted_ogre`, `corrupted_owlbear`, `grimlet`, `cultist_emperor`, `duskworm`, `demon`, `efreet_sultan`

**Event NPCs** (type=npc):
- `fish_merchant`, `gemstone_merchant`, `herbal_merchant`, `nomadic_merchant`, `timber_merchant`

**Key insight**: Event resources/monsters have NO permanent map tile. They only exist when the event is active (`/events/active`). The resource/item schemas have no flag indicating "event-only" — you have to cross-reference with `/events`.

### 1.3 strange_rocks / strange_ore

- Mining resource, level 35
- **No permanent map tile** on any layer (overworld, underground, interior, including blocked maps)
- Spawns from `strange_apparition` event — temporary, ~33 min between spawns, lasts 60s
- Every other mining resource (lv1–50) has a permanent map tile EXCEPT this one
- The orderboard has an open order for `strange_ore` x12 that is **unfulfillable** outside events
- GenoClaw4 claims this order every ~30s, fails to find location, releases, loops forever

### 1.4 Order Claim Loop (GenoClaw4)

GenoClaw4 repeatedly:
1. Claims `strange_ore` order (gather from `strange_rocks`)
2. Calls `getResourceLocation('strange_rocks')` → null (no permanent map)
3. Logs "Order claim invalid for gather strange_rocks; releasing claim"
4. Next cycle, claims it again

The `gold_ore` order correctly blocks with `insufficient_skill` (mining lv12 < required lv30), but the "no map location" path doesn't block — it just releases, allowing re-claim.

---

## 2. Proposed Fixes

### Fix A: Event-Aware Orderboard (Priority: High)

**Problem**: Orders get placed/claimed for event-only items that can't be obtained normally.

**Solution**:
1. On bot startup, fetch `/events` and cache a `Set<string>` of event content codes (resources + monsters)
2. Add helper: `isEventOnlyResource(code)` / `isEventOnlyMonster(code)` 
3. In `_placeOrderAndCancel` — don't place orders if the source resource/monster is event-only
4. In order claiming — skip event-only orders unless the event is currently active

**Where to add**:
- `src/services/game-data.mjs` — fetch events on init, expose `isEventContent(type, code)`
- `src/services/skill-rotation.mjs` — check before `_enqueueOrder()`
- `src/routines/skill-rotation.mjs` — check in `_ensureOrderClaim()` before claiming

**Event-active check** (optional enhancement): periodically poll `/events/active` and only claim event orders when the event is live. This would let characters opportunistically gather event resources when available.

### Fix B: Skill Level Pre-Check on Order Claims (Priority: High)

**Problem**: Characters claim gather orders they can't fulfill due to insufficient skill level.

**Solution**: Before claiming a gather order, check `character.skillLevel(resource.skill) >= resource.level`. If not, block the order for that character (like `insufficient_skill` already does for some paths).

**Where**: `_ensureOrderClaim()` in `src/routines/skill-rotation.mjs` — after matching an order but before claiming, verify skill requirements.

### Fix C: Block Orders with No Map Location (Priority: Medium)

**Problem**: When a resource has no map location, the order gets released (not blocked), causing infinite re-claim loop.

**Solution**: When `getResourceLocation()` returns null for an order's source, block the order for ALL characters (not just the current one) since no one can reach it. Use a different block reason like `no_map_location`.

**Where**: In `_executeGathering()` where it currently does `_clearActiveOrderClaim(ctx, { reason: 'missing_gather_source' })` — change to block instead of release.

### Fix D: Underground/Interior Navigation (Priority: Low — Future)

**Problem**: Bot can't navigate to underground or interior layers. Resources like mithril_rocks and adamantite_rocks are underground.

**Solution**:
1. Extend `getResourceLocation()` to return layer info alongside coordinates
2. Extend `moveTo()` to handle cross-layer navigation:
   - Find nearest transition point to target layer
   - Move to transition tile
   - Execute transition action
   - Move to destination on new layer
3. Handle transition conditions (key costs, item requirements)
4. Track current layer in character context

**Scope**: This is a bigger feature. The bot currently only operates on the overworld. Adding layer navigation unlocks mithril (lv40) and adamantite (lv50) mining, plus interior content.

### Fix E: Item Task — Don't Deposit Task Materials (Priority: Low — Optimization)

**Problem**: When bot restarts during an item task crafting flow, the deposit-bank routine deposits task materials (e.g., ash_wood for ash_plank crafting), then item_task withdraws them again. Wasteful round-trip.

**Solution**: In the deposit routine, skip items that are needed for the active item task's recipe chain. Check `character.task` and `character.task_type === 'items'`, resolve the recipe, and exclude those materials from deposit.

---

## 3. Implementation Order

1. **Fix A + B** together — event awareness + skill pre-check (stops the claim loops)
2. **Fix C** — block unfindable orders (safety net for edge cases)
3. **Fix E** — deposit optimization (quality of life)
4. **Fix D** — underground navigation (new capability, bigger scope)
