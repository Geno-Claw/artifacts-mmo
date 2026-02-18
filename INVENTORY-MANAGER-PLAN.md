# Inventory Manager — Global State Tracking

## Problem

Characters operate in isolation. Each only knows its own inventory + a cached snapshot of the bank. Nobody tracks what other characters have equipped or in their inventories.

**Consequences:**
- Recycler thinks bank has surplus equipment, doesn't account for items equipped on other chars (the shield bug — recycled 3, left 5 in bank + 4 on chars = 9 total instead of 5)
- Gear optimizer can't tell if another char is using an item
- Race conditions on bank withdrawals — two chars can try to withdraw the same item
- Craft planning blind to materials held by other chars

## Solution

A singleton `InventoryManager` that tracks every item across bank + all character inventories + all character equipment. Updated in real-time as actions happen, zero extra API calls.

## Architecture

```
┌─────────────────────────────────────────────┐
│            InventoryManager                 │
│                                             │
│  bank: Map<code, qty>                       │
│  charInventory: Map<charName, Map<code,qty>>│
│  charEquipment: Map<charName, Map<code,qty>>│
│                                             │
│  globalCount(code) → total everywhere       │
│  bankCount(code) → just bank                │
│  equippedCount(code) → sum across all chars │
│  inventoryCount(code) → sum across all chars│
│  charHasEquipped(name, code) → boolean      │
│                                             │
│  initialize() → full sync (startup)         │
│  updateCharacter(name, data) → local update │
│  updateBank(force?) → refresh bank cache    │
└─────────────────────────────────────────────┘
```

## Implementation

### Phase 1: Core — `src/services/inventory-manager.mjs`

Singleton module. Internal state:

```js
let bank = new Map();           // code → qty
let charInventory = new Map();  // charName → Map<code, qty>
let charEquipment = new Map();  // charName → Map<code, qty>
```

#### `initialize()`
- Called once at startup (after `initGameData()`)
- Fetches all characters via existing `api.getAllCharacters()`
- Fetches bank items via existing `api.getBankItems()`
- Populates all three maps
- Cost: 1x `GET /my/characters` + bank fetch (already happens)

#### `updateCharacter(name, charData)`
- Called from `ctx.refresh()` — piggybacks on the existing `getCharacter` API call
- Rebuilds that char's inventory map from `charData.inventory`
- Rebuilds that char's equipment map from `charData.*_slot` fields
- **Zero extra API calls**

#### `updateBank(forceRefresh?)`
- Same TTL/cache logic as current `game-data.mjs` bank cache
- Updates the internal `bank` map
- Replaces (or wraps) `gameData.getBankItems()`

#### Query Methods

| Method | Returns | Use Case |
|--------|---------|----------|
| `globalCount(code)` | bank + all inventories + all equipment | Recycler surplus calc |
| `bankCount(code)` | bank only | Withdrawal decisions |
| `equippedCount(code)` | sum across all chars' equipment | Know how many are "in use" |
| `inventoryCount(code)` | sum across all chars' inventories | Know what's in transit |
| `charHasEquipped(name, code)` | boolean | Gear optimizer conflict check |
| `snapshot()` | full state object | Debugging / logging |

### Phase 2: Wire In

#### `bot.mjs`
```js
import { initialize as initInventory } from './services/inventory-manager.mjs';
// After initGameData():
await initInventory();
```

#### `context.mjs` → `refresh()`
```js
import { updateCharacter } from './services/inventory-manager.mjs';
// After this._char = await getCharacter(this.name):
updateCharacter(this.name, this._char);
```

#### `game-data.mjs` → `getBankItems()`
Either:
- Delegate to `inventoryManager.updateBank()` (preferred — single source of truth)
- Or keep both, but have inventory manager subscribe to bank refreshes

### Phase 3: Fix Recycler

`recycler.mjs` → `analyzeRecycleCandidates()`:

```js
// OLD:
const surplus = bankQty - keep;

// NEW:
import { globalCount } from './inventory-manager.mjs';
const totalOwned = globalCount(code);
const surplus = totalOwned - keep;
const toRecycle = Math.min(surplus, bankQty); // can only recycle what's in bank
```

### Phase 4: Fix Gear Optimizer

When selecting gear from bank for a character, check if the item is the last copy and another char has it equipped. Prevents "stealing" scenario.

```js
import { globalCount, equippedCount, bankCount } from './inventory-manager.mjs';
// Before withdrawing item for equip:
const inBank = bankCount(code);
const equipped = equippedCount(code);
// If inBank <= 0, skip — someone else already took it
```

### Phase 5 (Future): Reservations

Optional addition — a `reserve(code, qty, charName)` / `release()` system:
- When a char plans to withdraw something, it reserves it first
- Other chars see reserved items as unavailable
- Fully eliminates race conditions on concurrent bank access
- Not needed immediately if the recycler/optimizer fixes are sufficient

## Files Changed

| File | Action | Risk |
|------|--------|------|
| `src/services/inventory-manager.mjs` | **NEW** | None — new file |
| `src/bot.mjs` | Add `initInventory()` call | Low — startup only |
| `src/context.mjs` | Add `updateCharacter()` in `refresh()` | Low — append only |
| `src/services/recycler.mjs` | Use `globalCount` in surplus calc | Medium — changes recycling behavior |
| `src/services/game-data.mjs` | Delegate bank cache (optional) | Medium — refactor |
| `src/services/gear-optimizer.mjs` | Check availability before equip | Medium — changes gear selection |

## API Cost

**Zero additional API calls at runtime.**

- Startup: 1x `GET /my/characters` (new, trivial — one request)
- Runtime: `ctx.refresh()` already calls `getCharacter` per tick — we just pipe the response into the manager
- Bank: identical refresh logic, just centralized

## Testing

1. Start bot, check startup log shows all 5 chars' inventory/equipment loaded
2. Have one char equip a shield, verify `equippedCount('wooden_shield')` reflects it
3. Put 8 shields in bank with 4 on chars → recycler should recycle 7 (not 3)
4. Two chars try to withdraw same item → second one sees updated count and skips
