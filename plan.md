# Bank Expansion Fix — Simplified

## Current Problem
`canRun()` depends on `getBankItems()` to count used slots, which causes an infinite spin loop due to async cache invalidation.

## Scott's Direction
Remove slot-checking entirely. The only decision is: **can we afford the next expansion?**

## New Logic

**Decision:** `next_expansion_cost <= totalGold * maxGoldPct`

That's it. If we can afford it without spending more than `maxGoldPct` of total gold, buy it. The `maxGoldPct` config (default 0.7) acts as the gold buffer — ensures we don't blow all our money on expansions.

### Changes to `bank-expansion.mjs`:

1. **Remove `getBankItems` import** — no longer needed
2. **Remove `slotThreshold` config** — no longer relevant
3. **Simplify `canRun()`:**
   ```js
   canRun(ctx) {
     if (_purchasing) return false;
     const now = Date.now();
     if (!_bankDetails || (now - _detailsFetchedAt) >= this.checkIntervalMs) return true;
     const cost = _bankDetails.next_expansion_cost;
     const totalGold = ctx.get().gold + (_bankDetails.gold || 0);
     return cost <= totalGold * this.maxGoldPct;
   }
   ```
4. **Simplify `_doExecute()`:**
   - Fetch `getBankDetails()` → cache it
   - Check affordability (`cost <= totalGold * maxGoldPct`)
   - If no → log and return
   - If yes → move to bank, withdraw gold if needed, purchase
5. **After purchase:** update cache optimistically (`_bankDetails.slots += 20`, refresh cost/gold) or just set `_detailsFetchedAt` so it refetches next cycle
6. **Remove `slotThreshold` from constructor, config schema, and characters.json**

### Config:
- `maxGoldPct` (default 0.7) — won't buy if cost > this % of total gold
- `checkIntervalMs` (default 300000) — how often to re-check the API

### Files to update:
- `src/routines/bank-expansion.mjs` — main changes
- `config/characters.json` — remove `slotThreshold` from all 5 entries
- `config/characters.schema.json` — remove `slotThreshold` from schema
