/**
 * Event Routine — participates in time-limited game events.
 *
 * High priority (90) with urgent=true to preempt SkillRotation mid-goal.
 * Configurable per-character. Handles monster, resource, and NPC events.
 *
 * Loop routine: execute() is called repeatedly by the scheduler.
 * Each call does ONE action (fight/gather), returns true to continue.
 * Scheduler re-checks canRun() and preemption between iterations.
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import * as eventManager from '../services/event-manager.mjs';
import { canCharacterBeatEvent } from '../services/event-simulation.mjs';
import { equipForCombat, equipForGathering } from '../services/gear-loadout.mjs';
import { moveTo, fightOnce, gatherOnce, parseFightResult, NoPathError } from '../helpers.mjs';
import { restBeforeFight } from '../services/food-manager.mjs';
import { hpNeededForFight } from '../services/combat-simulator.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';
import { getItemsForNpc } from '../services/npc-buy-config.mjs';
import { getOrderBoardSnapshot } from '../services/order-board.mjs';
import { globalCount, getBankSummary } from '../services/inventory-manager.mjs';
import { withdrawGoldFromBank } from '../services/bank-ops.mjs';
import * as npcEventLock from '../services/npc-event-lock.mjs';

const TAG = 'Event';

export class EventRoutine extends BaseRoutine {
  constructor({
    priority = 90,
    enabled = true,
    monsterEvents = true,
    resourceEvents = true,
    npcEvents = false,
    minTimeRemainingMs = 120_000,
    maxMonsterType = 'elite',
    cooldownMs = 60_000,
    minWinrate = 80,
    ...rest
  } = {}) {
    super({ name: TAG, priority, loop: true, urgent: true, type: rest.type });
    this.enabled = enabled;
    this.monsterEvents = monsterEvents;
    this.resourceEvents = resourceEvents;
    this.npcEvents = npcEvents;
    this.minTimeRemainingMs = minTimeRemainingMs;
    this.maxMonsterType = maxMonsterType;
    this.cooldownMs = cooldownMs;
    this.minWinrate = minWinrate;

    /** @type {{ code, type, monsterCode?, resourceCode?, map } | null} */
    this._targetEvent = null;
    /** Whether we've already equipped/traveled for the current event target. */
    this._prepared = false;
    /** Per-event cooldown tracking: { eventCode: timestampMs } */
    this._eventCooldowns = {};
    /** Character name holding the NPC lock (for release in _clearTarget). */
    this._lockCharName = null;
    /** Backoff timestamp — canRun() returns false until this passes. */
    this._canRunBackoffUntil = 0;
  }

  updateConfig(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled;
    if (cfg.monsterEvents !== undefined) this.monsterEvents = cfg.monsterEvents;
    if (cfg.resourceEvents !== undefined) this.resourceEvents = cfg.resourceEvents;
    if (cfg.npcEvents !== undefined) this.npcEvents = cfg.npcEvents;
    if (cfg.minTimeRemainingMs !== undefined) this.minTimeRemainingMs = cfg.minTimeRemainingMs;
    if (cfg.maxMonsterType !== undefined) this.maxMonsterType = cfg.maxMonsterType;
    if (cfg.cooldownMs !== undefined) this.cooldownMs = cfg.cooldownMs;
    if (cfg.minWinrate !== undefined) this.minWinrate = cfg.minWinrate;
  }

  canRun(ctx) {
    if (!this.enabled) return false;
    if (ctx.inventoryFull()) return false;

    // Backoff after event routine can't act — prevents preemption thrashing
    // where gather loop yields, event runs but fails, gather yields again.
    if (this._canRunBackoffUntil && Date.now() < this._canRunBackoffUntil) {
      return false;
    }

    // If we have a target, check it's still valid (and not on cooldown)
    if (this._targetEvent) {
      if (eventManager.isEventActive(this._targetEvent.code)) {
        if (!this._isOnCooldown(this._targetEvent.code, Date.now())) {
          return true;
        }
        // Target is on cooldown — clear it and look for another
        this._clearTarget();
      } else {
        // Event expired — clear target (and release NPC lock if held)
        this._clearTarget();
      }
    }

    // Find a new event target
    const target = this._findBestEvent(ctx);
    if (!target) return false;

    this._targetEvent = target;
    this._prepared = false;
    return true;
  }

  canBePreempted(_ctx) {
    // Rest (100) can preempt us. Since we're at 90, only routines >90 can.
    return true;
  }

  async execute(ctx) {
    const target = this._targetEvent;
    if (!target) {
      this._canRunBackoffUntil = Date.now() + 30_000;
      return false;
    }

    // Check event still active
    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned, aborting`);
      this._clearTarget();
      this._canRunBackoffUntil = Date.now() + 30_000;
      return false;
    }

    const result = await this._executeByType(ctx, target);
    if (!result) {
      // Event couldn't act (sim fail, cooldown, etc.) — back off 30s
      this._canRunBackoffUntil = Date.now() + 30_000;
    } else {
      // Successfully acted — clear any backoff
      this._canRunBackoffUntil = 0;
    }
    return result;
  }

  async _executeByType(ctx, target) {
    switch (target.type) {
      case 'monster': return this._executeMonster(ctx, target);
      case 'resource': return this._executeResource(ctx, target);
      case 'npc': return this._executeNpc(ctx, target);
      default:
        log.warn(`[${ctx.name}] ${TAG}: unknown event type "${target.type}"`);
        this._clearTarget();
        return false;
    }
  }

  // --- Monster events ---

  async _executeMonster(ctx, target) {
    const { monsterCode, map } = target;

    // First iteration: equip, prepare, travel
    if (!this._prepared) {
      // Re-check active before expensive prep
      if (!eventManager.isEventActive(target.code)) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before prep`);
        this._clearTarget();
        return false;
      }

      // Simulate fight BEFORE equipping gear (avoid wasteful gear swaps)
      const sim = await canCharacterBeatEvent(ctx, monsterCode, {
        minWinrate: this.minWinrate,
      });
      log.info(`[${ctx.name}] ${TAG}: ${monsterCode} simulation: ${sim.winrate}% winrate (${sim.source}) → ${sim.canWin ? 'GO' : 'SKIP'}`);
      if (!sim.canWin) {
        log.info(`[${ctx.name}] ${TAG}: skipping ${monsterCode} — winrate ${sim.winrate}% < ${this.minWinrate}% threshold`);
        this._setSimCooldown(target.code);
        this._clearTarget();
        return false;
      }

      const { ready = true } = await equipForCombat(ctx, monsterCode);
      if (!ready) {
        log.warn(`[${ctx.name}] ${TAG}: gear not ready for ${monsterCode}, deferring`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }

      await prepareCombatPotions(ctx, monsterCode);

      // Check again before travel
      if (!eventManager.isEventActive(target.code)) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before travel`);
        this._clearTarget();
        return false;
      }

      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to event at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }

      this._prepared = true;
    }

    // Re-travel if we moved (e.g., after bank deposit)
    if (!ctx.isAt(map.x, map.y)) {
      if (!eventManager.isEventActive(target.code)) {
        this._clearTarget();
        return false;
      }
      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to event at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }
    }

    // Check active before fight
    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before fight`);
      this._clearTarget();
      return false;
    }

    // Rest / eat before fight
    if (!(await restBeforeFight(ctx, monsterCode))) {
      const minHp = hpNeededForFight(ctx, monsterCode);
      if (minHp === null) {
        log.warn(`[${ctx.name}] ${TAG}: ${monsterCode} unbeatable, giving up on event`);
        ctx.recordLoss(monsterCode);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      log.info(`[${ctx.name}] ${TAG}: insufficient HP for ${monsterCode}, yielding for rest`);
      return false;
    }

    // Fight
    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monsterCode);
      log.info(`[${ctx.name}] ${TAG} ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''}`);

      if (ctx.inventoryFull()) {
        log.info(`[${ctx.name}] ${TAG}: inventory full, yielding for deposit`);
        return false; // Preserve target + prepared state for resumption
      }

      // Check time remaining
      if (eventManager.getTimeRemaining(target.code) < 30_000) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
        this._clearTarget();
        return false;
      }

      return true; // Continue loop
    }

    // Loss
    ctx.recordLoss(monsterCode);
    const losses = ctx.consecutiveLosses(monsterCode);
    log.warn(`[${ctx.name}] ${TAG} ${monsterCode}: LOSS ${r.turns}t (${losses} consecutive)`);
    this._setCooldown(target.code);
    this._clearTarget();
    return false;
  }

  // --- Resource events ---

  async _executeResource(ctx, target) {
    const { resourceCode, map } = target;

    if (!this._prepared) {
      if (!eventManager.isEventActive(target.code)) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before prep`);
        this._clearTarget();
        return false;
      }

      const resource = gameData.getResource(resourceCode);
      if (resource && resource.level > ctx.skillLevel(resource.skill)) {
        log.info(`[${ctx.name}] ${TAG}: ${resourceCode} requires ${resource.skill} lv${resource.level}, have lv${ctx.skillLevel(resource.skill)} — skipping`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      if (resource?.skill) {
        await equipForGathering(ctx, resource.skill);
      }

      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to event at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }

      this._prepared = true;
    }

    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before gather`);
      this._clearTarget();
      return false;
    }

    // Re-travel if we moved (e.g., after bank deposit)
    if (!ctx.isAt(map.x, map.y)) {
      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to event at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }
    }

    let result;
    try {
      result = await gatherOnce(ctx);
    } catch (err) {
      if (err.code === 493) {
        log.warn(`[${ctx.name}] ${TAG}: ${resourceCode} — skill too low (493), adding cooldown`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      throw err;
    }
    const items = result.details?.items || [];
    const xp = result.details?.xp || 0;
    log.info(`[${ctx.name}] ${TAG} ${resourceCode}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} +${xp}xp`);

    if (ctx.inventoryFull()) {
      log.info(`[${ctx.name}] ${TAG}: inventory full, yielding for deposit`);
      return false; // Preserve target + prepared state for resumption
    }

    if (eventManager.getTimeRemaining(target.code) < 30_000) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
      this._clearTarget();
      return false;
    }

    return true; // Continue gathering
  }

  // --- NPC events ---

  async _executeNpc(ctx, target) {
    const { map, npcCode } = target;

    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned`);
      this._clearTarget();
      return false;
    }

    // First iteration: acquire lock, prepare gold, travel
    if (!this._prepared) {
      // Acquire cross-character NPC lock
      if (!npcEventLock.acquire(ctx.name, npcCode, target.code)) {
        const holder = npcEventLock.getHolder();
        log.info(`[${ctx.name}] ${TAG}: NPC lock held by ${holder?.charName}, deferring`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      this._lockCharName = ctx.name;

      // Build gold-aware shopping list to determine how much gold we need
      const { items, totalCost, goldNeeded } = this._buildGoldAwareShoppingList(ctx, npcCode);
      if (items.length === 0) {
        log.info(`[${ctx.name}] ${TAG}: nothing affordable to buy from ${npcCode}`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }

      log.info(`[${ctx.name}] ${TAG}: ${npcCode} shopping plan: ${items.map(i => `${i.code}x${i.quantity} @${i.unitPrice}g`).join(', ')} | total ${totalCost}g, need ${goldNeeded}g from bank`);

      // Withdraw gold from bank if needed
      if (goldNeeded > 0) {
        try {
          await withdrawGoldFromBank(ctx, goldNeeded);
          log.info(`[${ctx.name}] ${TAG}: withdrew ${goldNeeded}g from bank for NPC purchases`);
        } catch (err) {
          log.warn(`[${ctx.name}] ${TAG}: gold withdrawal failed: ${err.message}, proceeding with carried gold`);
          // Don't abort — buy what we can with carried gold
        }
      }

      // Re-check event still active after bank trip
      if (!eventManager.isEventActive(target.code)) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned during gold withdrawal`);
        this._clearTarget();
        return false;
      }

      // Travel to NPC
      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to NPC at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }
      this._prepared = true;
    }

    // Re-travel if we moved (e.g., after bank deposit preemption)
    if (!ctx.isAt(map.x, map.y)) {
      if (!eventManager.isEventActive(target.code)) {
        this._clearTarget();
        return false;
      }
      try {
        await moveTo(ctx, map.x, map.y);
      } catch (err) {
        if (err instanceof NoPathError) {
          log.warn(`[${ctx.name}] ${TAG}: no path to NPC at (${map.x},${map.y})`);
          this._setCooldown(target.code);
          this._clearTarget();
          return false;
        }
        throw err;
      }
    }

    // Build shopping list each iteration (quantities change after purchases)
    const shoppingList = this._buildNpcShoppingList(ctx, npcCode);
    if (shoppingList.length === 0) {
      log.info(`[${ctx.name}] ${TAG}: nothing left to buy from ${npcCode}`);
      this._clearTarget();
      return false;
    }

    // Buy the first item on the list (one action per execute() call)
    const item = shoppingList[0];
    const space = ctx.inventoryCapacity() - ctx.inventoryCount();
    const buyQty = Math.min(item.quantity, space, 100); // API limit: 100 per action

    if (buyQty <= 0) {
      log.info(`[${ctx.name}] ${TAG}: inventory full, can't buy from ${npcCode}`);
      this._clearTarget();
      return false;
    }

    // Constrain buyQty to what we can afford
    let finalQty = buyQty;
    const unitPrice = gameData.getNpcBuyPrice(npcCode, item.code);
    if (unitPrice != null && unitPrice > 0) {
      const carriedGold = ctx.get().gold || 0;
      const maxAffordable = Math.floor(carriedGold / unitPrice);
      finalQty = Math.min(buyQty, maxAffordable);
      if (finalQty <= 0) {
        log.warn(`[${ctx.name}] ${TAG}: insufficient gold (${carriedGold}g) to buy ${item.code} @${unitPrice}g from ${npcCode}`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
    }

    try {
      const result = await api.npcBuy(item.code, finalQty, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);

      const cost = result.transaction?.total_price || 0;
      log.info(`[${ctx.name}] ${TAG} ${npcCode}: bought ${item.code} x${finalQty} for ${cost}g (${item.reason})`);
    } catch (err) {
      if (err.code === 598) {
        log.warn(`[${ctx.name}] ${TAG}: NPC not on map (598), event may have despawned`);
        this._clearTarget();
        return false;
      }
      if (err.code === 441) {
        log.warn(`[${ctx.name}] ${TAG}: ${item.code} not available from ${npcCode} (441)`);
        this._addNpcSkipItem(npcCode, item.code);
        return true; // Continue loop to try other items
      }
      if (err.code === 492) {
        log.warn(`[${ctx.name}] ${TAG}: not enough gold to buy ${item.code} from ${npcCode}`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      if (err.code === 497) {
        log.info(`[${ctx.name}] ${TAG}: inventory full (497)`);
        this._clearTarget();
        return false;
      }
      throw err;
    }

    // Check if we should continue buying
    if (ctx.inventoryFull()) {
      log.info(`[${ctx.name}] ${TAG}: inventory full after purchase, yielding`);
      this._clearTarget();
      return false;
    }

    if (eventManager.getTimeRemaining(target.code) < 30_000) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
      this._clearTarget();
      return false;
    }

    return true; // Continue buying loop
  }

  /**
   * Build a prioritized shopping list for an NPC merchant.
   * Sources: (1) npcBuyList config entries, (2) open order-board orders.
   * Only includes items the NPC actually sells (from loaded catalog).
   */
  _buildNpcShoppingList(ctx, npcCode) {
    const result = [];
    const seen = new Set();

    // Source 1: Items from npcBuyList config
    const configItems = getItemsForNpc(npcCode);
    for (const entry of configItems) {
      if (!gameData.canNpcSell(npcCode, entry.code)) continue;
      if (this._isNpcSkipItem(npcCode, entry.code)) continue;

      const current = globalCount(entry.code);
      const needed = entry.maxTotal - current;
      if (needed <= 0) continue;

      seen.add(entry.code);
      result.push({
        code: entry.code,
        quantity: needed,
        reason: `config (have ${current}/${entry.maxTotal})`,
      });
    }

    // Source 2: Open/claimed order-board orders matching NPC catalog
    const snapshot = getOrderBoardSnapshot();
    for (const order of snapshot.orders) {
      if (order.status === 'fulfilled') continue;
      if (order.remainingQty <= 0) continue;
      if (seen.has(order.itemCode)) continue;
      if (!gameData.canNpcSell(npcCode, order.itemCode)) continue;
      if (this._isNpcSkipItem(npcCode, order.itemCode)) continue;

      seen.add(order.itemCode);
      result.push({
        code: order.itemCode,
        quantity: order.remainingQty,
        reason: `order-board (${order.id.slice(0, 8)})`,
      });
    }

    return result;
  }

  /**
   * Gold-aware shopping list — trims quantities to what the character can afford
   * using carried gold + bank gold.
   * @returns {{ items: Array, totalCost: number, goldNeeded: number }}
   */
  _buildGoldAwareShoppingList(ctx, npcCode) {
    const raw = this._buildNpcShoppingList(ctx, npcCode);
    if (raw.length === 0) return { items: [], totalCost: 0, goldNeeded: 0 };

    const carriedGold = ctx.get().gold || 0;
    const bankGold = getBankSummary().gold || 0;
    const totalAvailable = carriedGold + bankGold;

    let runningCost = 0;
    const items = [];

    for (const entry of raw) {
      const unitPrice = gameData.getNpcBuyPrice(npcCode, entry.code);
      if (unitPrice == null || unitPrice <= 0) continue;

      const maxAffordable = Math.floor((totalAvailable - runningCost) / unitPrice);
      if (maxAffordable <= 0) continue;

      const qty = Math.min(entry.quantity, maxAffordable);
      const cost = qty * unitPrice;
      runningCost += cost;

      items.push({ ...entry, quantity: qty, unitPrice, totalCost: cost });
    }

    const goldNeeded = Math.max(0, runningCost - carriedGold);
    return { items, totalCost: runningCost, goldNeeded };
  }

  // --- Event selection ---

  _findBestEvent(ctx) {
    const now = Date.now();
    let best = null;
    let bestScore = -1;

    // Monster events
    if (this.monsterEvents) {
      const monsterEvents = eventManager.getActiveMonsterEvents();
      for (const evt of monsterEvents) {
        if (this._isOnCooldown(evt.code, now)) {
          log.info(`[${ctx.name}] ${TAG}: skipping ${evt.contentCode} — on cooldown`);
          continue;
        }
        const ttl = eventManager.getTimeRemaining(evt.code);
        if (ttl < this.minTimeRemainingMs) {
          log.info(`[${ctx.name}] ${TAG}: skipping ${evt.contentCode} — expires too soon (${Math.round(ttl / 1000)}s remaining)`);
          continue;
        }

        const monsterCode = evt.definition?.content?.code || evt.contentCode;
        if (monsterCode !== evt.contentCode) {
          log.info(`[${ctx.name}] ${TAG}: resolved ${evt.contentCode} → monster ${monsterCode} from definition`);
        }
        const monster = gameData.getMonster(monsterCode);

        if (monster) {
          // Skip boss (group deferred) and optionally elite
          if (monster.type === 'boss') {
            log.info(`[${ctx.name}] ${TAG}: skipping ${monsterCode} — boss type (group required)`);
            continue;
          }
          if (monster.type === 'elite' && this.maxMonsterType === 'normal') {
            log.info(`[${ctx.name}] ${TAG}: skipping ${monsterCode} — elite type exceeds max "${this.maxMonsterType}"`);
            continue;
          }

          // Score: higher-level = better, elite bonus
          const levelScore = monster.level || 0;
          const typeBonus = monster.type === 'elite' ? 20 : 0;
          const score = levelScore + typeBonus;

          if (score > bestScore) {
            bestScore = score;
            best = {
              code: evt.code,
              type: 'monster',
              monsterCode,
              map: evt.map,
            };
          }
        } else {
          // Event-only monster not in game data — still fightable
          log.info(`[${ctx.name}] ${TAG}: ${monsterCode} not in game data (event-only monster), attempting anyway`);
          const score = 10; // default score for unknown monsters
          if (score > bestScore) {
            bestScore = score;
            best = {
              code: evt.code,
              type: 'monster',
              monsterCode,
              map: evt.map,
            };
          }
        }
      }
      if (monsterEvents.length > 0 && !best) {
        log.info(`[${ctx.name}] ${TAG}: ${monsterEvents.length} active monster event(s) but none eligible`);
      }
    }

    // Resource events
    if (this.resourceEvents) {
      const gatherList = eventManager.getGatherResources();

      for (const evt of eventManager.getActiveResourceEvents()) {
        if (this._isOnCooldown(evt.code, now)) continue;
        if (eventManager.getTimeRemaining(evt.code) < this.minTimeRemainingMs) continue;

        const resourceCode = evt.definition?.content?.code || evt.contentCode;
        if (resourceCode !== evt.contentCode) {
          log.info(`[${ctx.name}] ${TAG}: resolved ${evt.contentCode} → resource ${resourceCode} from definition`);
        }

        // If a global gather list is configured, only respond to listed resources
        if (gatherList.length > 0 && !gatherList.includes(resourceCode)) continue;

        const resource = gameData.getResource(resourceCode);
        if (resource && resource.level > ctx.skillLevel(resource.skill)) continue;

        const score = resource?.level || 0;
        if (score > bestScore) {
          bestScore = score;
          best = {
            code: evt.code,
            type: 'resource',
            resourceCode,
            map: evt.map,
          };
        }
      }
    }

    // NPC events (single-character lock — only one char handles NPC events at a time)
    if (this.npcEvents) {
      for (const evt of eventManager.getActiveNpcEvents()) {
        if (this._isOnCooldown(evt.code, now)) continue;
        if (eventManager.getTimeRemaining(evt.code) < this.minTimeRemainingMs) continue;

        // Skip if another character already holds the NPC event lock
        if (npcEventLock.isHeld() && !npcEventLock.isHeldBy(ctx.name)) continue;

        const npcCode = evt.contentCode;

        // Check if we have anything to buy from this NPC
        const shoppingList = this._buildNpcShoppingList(ctx, npcCode);
        if (shoppingList.length === 0) continue;

        // NPCs score lower than monsters — only pick if no monster event
        const score = 1;
        if (score > bestScore) {
          bestScore = score;
          best = {
            code: evt.code,
            type: 'npc',
            npcCode,
            map: evt.map,
          };
        }
      }
    }

    return best;
  }

  // --- Helpers ---

  _isOnCooldown(eventCode, now) {
    const last = this._eventCooldowns[eventCode];
    if (last && (now - last) < this.cooldownMs) return true;
    // Sim failure cooldown: lasts until the event expires (stored as expiry timestamp)
    const simExpiry = this._simCooldowns?.[eventCode];
    if (simExpiry && now < simExpiry) return true;
    return false;
  }

  _setCooldown(eventCode) {
    this._eventCooldowns[eventCode] = Date.now();
  }

  /**
   * Cooldown for simulation failures — lasts until the event expires so we
   * don't repeatedly try (and fail) the same event.
   * @param {string} eventCode
   */
  _setSimCooldown(eventCode) {
    if (!this._simCooldowns) this._simCooldowns = {};
    const ttl = eventManager.getTimeRemaining(eventCode);
    // Store the expiry time rather than the start time
    this._simCooldowns[eventCode] = Date.now() + Math.max(ttl, 60_000);
  }

  _clearTarget() {
    if (this._targetEvent?.type === 'npc' && this._lockCharName) {
      npcEventLock.release(this._lockCharName);
    }
    this._targetEvent = null;
    this._prepared = false;
    this._lockCharName = null;
  }

  // --- NPC skip list (persists across events of same NPC type) ---

  _addNpcSkipItem(npcCode, itemCode) {
    if (!this._npcSkipItems) this._npcSkipItems = new Map();
    let set = this._npcSkipItems.get(npcCode);
    if (!set) {
      set = new Set();
      this._npcSkipItems.set(npcCode, set);
    }
    set.add(itemCode);
  }

  _isNpcSkipItem(npcCode, itemCode) {
    return this._npcSkipItems?.get(npcCode)?.has(itemCode) || false;
  }
}
