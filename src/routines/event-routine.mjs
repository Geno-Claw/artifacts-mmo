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
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import * as eventManager from '../services/event-manager.mjs';
import { canCharacterBeatEvent } from '../services/event-simulation.mjs';
import { equipForCombat, equipForGathering } from '../services/gear-loadout.mjs';
import { moveTo, fightOnce, gatherOnce, parseFightResult, NoPathError } from '../helpers.mjs';
import { restBeforeFight } from '../services/food-manager.mjs';
import { prepareCombatPotions } from '../services/potion-manager.mjs';

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

    // If we have a target, check it's still valid
    if (this._targetEvent) {
      if (eventManager.isEventActive(this._targetEvent.code)) {
        return true;
      }
      // Event expired — clear target
      this._targetEvent = null;
      this._prepared = false;
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
    if (!target) return false;

    // Check event still active
    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned, aborting`);
      this._clearTarget();
      return false;
    }

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

    // Check active before fight
    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned before fight`);
      this._clearTarget();
      return false;
    }

    // Rest / eat before fight
    if (!(await restBeforeFight(ctx, monsterCode))) {
      log.warn(`[${ctx.name}] ${TAG}: can't rest before ${monsterCode}, fighting anyway`);
    }

    // Fight
    const result = await fightOnce(ctx);
    const r = parseFightResult(result, ctx);

    if (r.win) {
      ctx.clearLosses(monsterCode);
      log.info(`[${ctx.name}] ${TAG} ${monsterCode}: WIN ${r.turns}t | +${r.xp}xp +${r.gold}g${r.drops ? ' | ' + r.drops : ''}`);

      if (ctx.inventoryFull()) {
        log.info(`[${ctx.name}] ${TAG}: inventory full, yielding`);
        this._clearTarget();
        return false;
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

    const result = await gatherOnce(ctx);
    const items = result.details?.items || [];
    const xp = result.details?.xp || 0;
    log.info(`[${ctx.name}] ${TAG} ${resourceCode}: gathered ${items.map(i => `${i.code}x${i.quantity}`).join(', ') || 'nothing'} +${xp}xp`);

    if (ctx.inventoryFull()) {
      log.info(`[${ctx.name}] ${TAG}: inventory full, yielding`);
      this._clearTarget();
      return false;
    }

    if (eventManager.getTimeRemaining(target.code) < 30_000) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} expiring soon, yielding`);
      this._clearTarget();
      return false;
    }

    return true; // Continue gathering
  }

  // --- NPC events (V1 framework) ---

  async _executeNpc(ctx, target) {
    const { map } = target;

    if (!eventManager.isEventActive(target.code)) {
      log.info(`[${ctx.name}] ${TAG}: ${target.code} despawned`);
      this._clearTarget();
      return false;
    }

    try {
      await moveTo(ctx, map.x, map.y);
    } catch (err) {
      if (err instanceof NoPathError) {
        log.warn(`[${ctx.name}] ${TAG}: no path to NPC event at (${map.x},${map.y})`);
        this._setCooldown(target.code);
        this._clearTarget();
        return false;
      }
      throw err;
    }

    log.info(`[${ctx.name}] ${TAG}: arrived at NPC event ${target.code} at (${map.x},${map.y}). Buy/sell logic not implemented yet.`);
    this._clearTarget();
    return false; // Framework only — no trading yet
  }

  // --- Event selection ---

  _findBestEvent(ctx) {
    const now = Date.now();
    let best = null;
    let bestScore = -1;

    // Monster events
    if (this.monsterEvents) {
      for (const evt of eventManager.getActiveMonsterEvents()) {
        if (this._isOnCooldown(evt.code, now)) continue;
        if (eventManager.getTimeRemaining(evt.code) < this.minTimeRemainingMs) continue;

        const monsterCode = evt.contentCode;
        const monster = gameData.getMonster(monsterCode);
        if (!monster) continue;

        // Skip boss (group deferred) and optionally elite
        if (monster.type === 'boss') continue;
        if (monster.type === 'elite' && this.maxMonsterType === 'normal') continue;

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
      }
    }

    // Resource events
    if (this.resourceEvents) {
      for (const evt of eventManager.getActiveResourceEvents()) {
        if (this._isOnCooldown(evt.code, now)) continue;
        if (eventManager.getTimeRemaining(evt.code) < this.minTimeRemainingMs) continue;

        const resourceCode = evt.contentCode;
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

    // NPC events
    if (this.npcEvents) {
      for (const evt of eventManager.getActiveNpcEvents()) {
        if (this._isOnCooldown(evt.code, now)) continue;
        if (eventManager.getTimeRemaining(evt.code) < this.minTimeRemainingMs) continue;

        // NPCs score lower than monsters — only pick if no monster event
        const score = 1;
        if (score > bestScore) {
          bestScore = score;
          best = {
            code: evt.code,
            type: 'npc',
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
    return !!last && (now - last) < this.cooldownMs;
  }

  _setCooldown(eventCode) {
    this._eventCooldowns[eventCode] = Date.now();
  }

  _clearTarget() {
    this._targetEvent = null;
    this._prepared = false;
  }
}
