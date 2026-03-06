# Bug: Gear State Availability Pool Double-Claims Equipped Items

## Summary

Characters can "claim" items that are equipped on other characters, causing the system to think they already have gear they don't. This prevents orders from being placed for missing items.

## Reproduction

- GC2 has `healing_rune` equipped (the only one in the account)
- GC1 has an empty rune slot
- Gear state shows GC1 with `available: {healing_rune: 1}` and `assigned: {healing_rune: 1}`
- No order exists for GC1's healing rune — the system thinks he already has one
- In reality, GC1 has nothing

## Root Cause

`refreshGearState()` in `gear-state.mjs` (~line 435):

```js
const availability = new Map();
for (const code of allCodes) {
  availability.set(code, Math.max(0, toPositiveInt(_deps.globalCountFn(code))));
}
```

`globalCount()` in `inventory-manager.mjs` returns:
```js
bankCount(code) + inventoryCount(code) + equippedCount(code)
```

This creates a **single shared pool** that includes items equipped on all characters. Characters then claim from this pool in `characterOrder` sequence (GC1 first, GC2 second, etc.):

```js
const available = availability.get(code) || 0;
const assignQty = Math.min(need, available);
if (assignQty > 0) assigned.set(code, assignQty);
availability.set(code, Math.max(0, available - assignQty));
```

So what happens:
1. Pool: `healing_rune = 1` (from GC2's equipped slot)
2. GC1 needs healing_rune → claims 1, pool drops to 0
3. GC2 needs healing_rune → pool is 0, goes to `desired`
4. GC2 already has it equipped so no real harm to GC2
5. GC1 thinks he has one assigned — no order placed, but he actually has nothing

The pool doesn't track *where* items are. An item on GC2's body looks the same as one in the bank.

## Suggested Fix

**Pre-assign equipped items to their owner before pool allocation.**

1. Change the availability pool to exclude equipped items:
   ```js
   // Use bankCount + inventoryCount only (not equippedCount)
   availability.set(code, bankCount(code) + inventoryCount(code));
   ```

2. Before the shared pool allocation loop, seed each character's `assigned` map with their own equipped items that match their `selected` needs:
   ```js
   // For each character, pre-assign their own equipped gear
   for (const [code, qty] of selected.entries()) {
     const equippedOnSelf = charEquippedCount(name, code); // new helper or existing
     if (equippedOnSelf > 0) {
       const preAssign = Math.min(qty, equippedOnSelf);
       assigned.set(code, preAssign);
       // Reduce remaining need before drawing from shared pool
     }
   }
   ```

3. Then allocate remaining needs from the shared bank+inventory pool as before.

This ensures:
- GC2's equipped healing_rune stays assigned to GC2
- GC1 sees 0 available → healing_rune goes into `desired` → order gets created
- Items in bank/inventory are still shared fairly across characters
- No change to the allocation priority logic for non-equipped items

## Impact

Any item that exists only as equipped gear on one character can be phantom-claimed by a higher-priority character, suppressing orders. This likely affects runes most (single-copy, NPC-purchased items) but could affect any scarce equipment.
