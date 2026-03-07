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
import { getFightReadiness } from '../services/food-manager.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';
import { getItemsForNpc } from '../services/npc-buy-config.mjs';
import { getOrderBoardSnapshot } from '../services/order-board.mjs';
import { globalCount, getBankSummary, bankCount } from '../services/inventory-manager.mjs';
import { withdrawGoldFromBank, withdrawBankItems } from '../services/bank-ops.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';
import { buildNpcCurrencyPlan, maxAffordableQuantity, missingCurrencyForQuantity } from '../services/npc-trade-planner.mjs';
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
      return this._yield('yield_for_backoff', { reason: 'no_target' });
    }

    // Check event still active
    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned, aborting`);
      this._clearTarget();
      this._canRunBackoffUntil = Date.now() + 30_000;
      return this._yield('event_expired', { eventCode: target.code });
    }

    const result = await this._executeByType(ctx, target);
    if (!result) {
      // Event couldn't act (sim fail, cooldown, etc.) — back off 30s
      this._canRunBackoffUntil = Date.now() + 30_000;
      this._setYieldReason('yield_for_backoff', { eventCode: target.code });
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
    const readiness = await getFightReadiness(ctx, monsterCode);
    if (readiness.status !== 'ready') {
      if (readiness.status === 'unwinnable') {
        log.warn(`[${ctx.name}] ${TAG}: ${monsterCode} not safely fightable, giving up on event`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      log.info(`[${ctx.name}] ${TAG}: insufficient HP for ${monsterCode}, yielding for rest`);
      return this._yield('yield_for_rest', {
        eventCode: target.code,
        monsterCode,
        requiredHp: readiness.requiredHp,
        currentHp: ctx.get().hp,
      });
    }

    // Fight
    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monsterCode);
      log.info(`[${ctx.name}] ${TAG} ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''}`);

      if (ctx.inventoryFull()) {
        log.info(`[${ctx.name}] ${TAG}: inventory full, yielding for deposit`);
        return this._yield('yield_for_deposit', {
          eventCode: target.code,
          monsterCode,
        }); // Preserve target + prepared state for resumption
      }

      // Check time remaining
      if (eventManager.getTimeRemaining(target.code) < 30_000) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
        this._clearTarget();
        return this._yield('event_expired', { eventCode: target.code });
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
      return this._yield('yield_for_deposit', {
        eventCode: target.code,
        resourceCode,
      }); // Preserve target + prepared state for resumption
    }

    if (eventManager.getTimeRemaining(target.code) < 30_000) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
      this._clearTarget();
      return this._yield('event_expired', { eventCode: target.code });
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

    // First iteration: acquire lock, prepare currencies, travel
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

      const plan = this._buildCurrencyAwareShoppingPlan(ctx, npcCode);
      const { items } = plan;
      if (items.length === 0) {
        log.info(`[${ctx.name}] ${TAG}: nothing affordable to buy from ${npcCode}`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }

      const planSummary = items
        .map(i => `${i.code}x${i.quantity} @${this._formatUnitPrice(i.unitPrice, i.currency)}`)
        .join(', ');
      const totalByCurrency = [...plan.spentByCurrency.entries()]
        .map(([currency, amount]) => this._formatCost(amount, currency))
        .join(', ') || 'none';
      const neededFromBankSummary = [...plan.neededFromBank.entries()]
        .filter(([, amount]) => amount > 0)
        .map(([currency, amount]) => this._formatCost(amount, currency))
        .join(', ') || 'none';

      log.info(
        `[${ctx.name}] ${TAG}: ${npcCode} shopping plan: ${planSummary} | total ${totalByCurrency}, need from bank ${neededFromBankSummary}`,
      );

      // Withdraw gold from bank if needed
      const goldNeeded = plan.neededFromBank.get('gold') || 0;
      if (goldNeeded > 0) {
        try {
          await withdrawGoldFromBank(ctx, goldNeeded);
          log.info(`[${ctx.name}] ${TAG}: withdrew ${goldNeeded}g from bank for NPC purchases`);
        } catch (err) {
          log.warn(`[${ctx.name}] ${TAG}: gold withdrawal failed: ${err.message}, proceeding with carried currency`);
          // Don't abort — buy what we can with carried currency
        }
      }

      // Withdraw non-gold currencies from bank if needed
      const itemCurrencyRows = [...plan.neededFromBank.entries()]
        .filter(([currency, amount]) => currency !== 'gold' && amount > 0)
        .map(([currency, amount]) => ({ code: currency, quantity: amount }));
      if (itemCurrencyRows.length > 0) {
        try {
          const result = await withdrawBankItems(ctx, itemCurrencyRows, {
            reason: `${TAG} NPC prep currency withdrawal`,
          });
          const withdrawnSummary = result.withdrawn.map(i => `${i.code}x${i.quantity}`).join(', ');
          if (withdrawnSummary) {
            log.info(`[${ctx.name}] ${TAG}: withdrew currency items from bank: ${withdrawnSummary}`);
          }
          logWithdrawalWarnings(ctx, result, `${TAG} NPC currency withdrawal`);
        } catch (err) {
          log.warn(`[${ctx.name}] ${TAG}: currency item withdrawal failed: ${err.message}, proceeding with carried currency`);
        }
      }

      // Re-check event still active after bank trip
      if (!eventManager.isEventActive(target.code)) {
        log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned during currency withdrawal`);
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

    const space = ctx.inventoryCapacity() - ctx.inventoryCount();
    if (space <= 0) {
      log.info(`[${ctx.name}] ${TAG}: inventory full, can't buy from ${npcCode}`);
      this._clearTarget();
      return false;
    }

    // Evaluate shopping list in priority order. If an item is unaffordable,
    // attempt currency top-up first, then fall through to later items.
    let purchase = null;
    for (const item of shoppingList) {
      const offer = gameData.getNpcBuyOffer(npcCode, item.code);
      if (!offer) continue;

      const desiredQty = Math.min(item.quantity, space, 100); // API limit: 100 per action
      if (desiredQty <= 0) continue;

      let carriedCurrency = this._carriedCurrency(ctx, offer.currency);
      let affordable = maxAffordableQuantity(offer.buyPrice, carriedCurrency);

      if (affordable <= 0) {
        const missing = missingCurrencyForQuantity(desiredQty, offer.buyPrice, carriedCurrency);
        if (missing > 0) {
          await this._topUpNpcCurrency(ctx, offer.currency, missing, npcCode, item.code);
        }

        if (!eventManager.isEventActive(target.code)) {
          log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned during top-up`);
          this._clearTarget();
          return false;
        }

        if (!ctx.isAt(map.x, map.y)) {
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

        carriedCurrency = this._carriedCurrency(ctx, offer.currency);
        affordable = maxAffordableQuantity(offer.buyPrice, carriedCurrency);
      }

      const finalQty = Math.min(desiredQty, affordable);
      if (finalQty <= 0) {
        log.warn(
          `[${ctx.name}] ${TAG}: insufficient ${offer.currency} (${carriedCurrency}) to buy ${item.code} @${this._formatUnitPrice(offer.buyPrice, offer.currency)} from ${npcCode}; trying next item`,
        );
        continue;
      }

      purchase = { item, offer, finalQty };
      break;
    }

    if (!purchase) {
      log.info(`[${ctx.name}] ${TAG}: nothing purchasable right now from ${npcCode}`);
      this._setCooldown(target.code);
      this._clearTarget();
      return false;
    }

    const { item, offer, finalQty } = purchase;

    try {
      const result = await api.npcBuy(item.code, finalQty, ctx.name);
      ctx.applyActionResult(result);
      await api.waitForCooldown(result);

      const txCurrency = result.transaction?.currency || offer.currency;
      const txTotalPrice = Number(result.transaction?.total_price);
      const totalPaid = Number.isFinite(txTotalPrice) ? txTotalPrice : (finalQty * offer.buyPrice);
      log.info(
        `[${ctx.name}] ${TAG} ${npcCode}: bought ${item.code} x${finalQty} for ${this._formatCost(totalPaid, txCurrency)} (${item.reason})`,
      );
    } catch (err) {
      const handled = this._handleNpcBuyError(ctx, target, npcCode, item, offer, err);
      if (handled.handled) return handled.result;
      throw err;
    }

    // Check if we should continue buying
    if (ctx.inventoryFull()) {
      log.info(`[${ctx.name}] ${TAG}: inventory full after purchase, yielding`);
      this._clearTarget();
      return this._yield('yield_for_deposit', {
        eventCode: target.code,
        npcCode,
      });
    }

    if (eventManager.getTimeRemaining(target.code) < 30_000) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
      this._clearTarget();
      return this._yield('event_expired', { eventCode: target.code });
    }

    return true; // Continue buying loop
  }

  _handleNpcBuyError(ctx, target, npcCode, item, offer, err) {
    if (err.code === 598) {
      log.warn(`[${ctx.name}] ${TAG}: NPC not on map (598), event may have despawned`);
      this._clearTarget();
      return { handled: true, result: false };
    }
    if (err.code === 441) {
      log.warn(`[${ctx.name}] ${TAG}: ${item.code} not available from ${npcCode} (441)`);
      this._addNpcSkipItem(npcCode, item.code);
      return { handled: true, result: true };
    }
    if (err.code === 492) {
      log.warn(`[${ctx.name}] ${TAG}: not enough gold to buy ${item.code} from ${npcCode}`);
      this._setCooldown(target.code);
      this._clearTarget();
      return { handled: true, result: false };
    }
    if (err.code === 478) {
      log.warn(
        `[${ctx.name}] ${TAG}: missing required item currency (${offer.currency}) to buy ${item.code} from ${npcCode} (478)`,
      );
      this._setCooldown(target.code);
      this._clearTarget();
      return { handled: true, result: false };
    }
    if (err.code === 497) {
      log.info(`[${ctx.name}] ${TAG}: inventory full (497)`);
      this._clearTarget();
      return { handled: true, result: false };
    }
    return { handled: false };
  }

  _carriedCurrency(ctx, currency) {
    if (currency === 'gold') return Math.max(0, Number(ctx.get().gold) || 0);
    return Math.max(0, Number(ctx.itemCount(currency)) || 0);
  }

  _bankCurrency(currency) {
    if (currency === 'gold') return Math.max(0, Number(getBankSummary().gold) || 0);
    return Math.max(0, Number(bankCount(currency)) || 0);
  }

  _formatUnitPrice(unitPrice, currency) {
    const price = Math.max(0, Number(unitPrice) || 0);
    if (currency === 'gold') return `${price}g`;
    return `${price} ${currency}`;
  }

  _formatCost(amount, currency) {
    const total = Math.max(0, Number(amount) || 0);
    if (currency === 'gold') return `${total}g`;
    return `${total} ${currency}`;
  }

  async _topUpNpcCurrency(ctx, currency, quantity, npcCode, itemCode) {
    const needed = Math.max(0, Number(quantity) || 0);
    if (needed <= 0) return;

    if (currency === 'gold') {
      try {
        await withdrawGoldFromBank(ctx, needed);
        log.info(`[${ctx.name}] ${TAG}: withdrew ${needed}g for ${itemCode} from ${npcCode}`);
      } catch (err) {
        log.warn(`[${ctx.name}] ${TAG}: gold top-up failed for ${itemCode}: ${err.message}`);
      }
      return;
    }

    try {
      const result = await withdrawBankItems(ctx, [{ code: currency, quantity: needed }], {
        reason: `${TAG} NPC top-up for ${itemCode}`,
      });
      const withdrawn = result.withdrawn.find(row => row.code === currency)?.quantity || 0;
      if (withdrawn > 0) {
        log.info(`[${ctx.name}] ${TAG}: withdrew ${currency} x${withdrawn} for ${itemCode} from ${npcCode}`);
      }
      logWithdrawalWarnings(ctx, result, `${TAG} NPC currency top-up`);
    } catch (err) {
      log.warn(`[${ctx.name}] ${TAG}: item-currency top-up failed for ${itemCode}: ${err.message}`);
    }
  }

  /**
   * Currency-aware shopping plan — trims quantities to what the character can
   * afford using carried currency + bank currency for each NPC item currency.
   */
  _buildCurrencyAwareShoppingPlan(ctx, npcCode) {
    const raw = this._buildNpcShoppingList(ctx, npcCode);
    return buildNpcCurrencyPlan(raw, {
      getOffer: (itemCode) => gameData.getNpcBuyOffer(npcCode, itemCode),
      getCarried: (currency) => this._carriedCurrency(ctx, currency),
      getBank: (currency) => this._bankCurrency(currency),
    });
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
          log.debug(`[${ctx.name}] ${TAG}: skipping ${evt.contentCode} — on cooldown`);
          continue;
        }
        const ttl = eventManager.getTimeRemaining(evt.code);
        if (ttl < this.minTimeRemainingMs) {
          log.debug(`[${ctx.name}] ${TAG}: skipping ${evt.contentCode} — expires too soon (${Math.round(ttl / 1000)}s remaining)`);
          continue;
        }

        const monsterCode = evt.definition?.content?.code || evt.contentCode;
        if (monsterCode !== evt.contentCode) {
          log.debug(`[${ctx.name}] ${TAG}: resolved ${evt.contentCode} → monster ${monsterCode} from definition`);
        }
        const monster = gameData.getMonster(monsterCode);

        if (monster) {
          // Skip boss (group deferred) and optionally elite
          if (monster.type === 'boss') {
            log.debug(`[${ctx.name}] ${TAG}: skipping ${monsterCode} — boss type (group required)`);
            continue;
          }
          if (monster.type === 'elite' && this.maxMonsterType === 'normal') {
            log.debug(`[${ctx.name}] ${TAG}: skipping ${monsterCode} — elite type exceeds max "${this.maxMonsterType}"`);
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
          log.debug(`[${ctx.name}] ${TAG}: ${monsterCode} not in game data (event-only monster), attempting anyway`);
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
        log.debug(`[${ctx.name}] ${TAG}: ${monsterEvents.length} active monster event(s) but none eligible`);
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
