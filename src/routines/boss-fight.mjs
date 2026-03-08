/**
 * Boss Fight Routine — coordinates multi-character group boss fights.
 *
 * Priority 15, non-urgent, loop routine. Characters finish their current
 * SkillRotation goal before joining (canBePreempted returns true between goals).
 *
 * One character becomes the evaluator/leader, runs gear optimization and
 * team simulation, then creates a rally via boss-rally service. All
 * participants converge on the boss tile, equip gear, withdraw food, and
 * check in. Leader initiates the fight and publishes the result.
 */
import { BaseRoutine } from './base.mjs';
import * as api from '../api.mjs';
import * as log from '../log.mjs';
import * as gameData from '../services/game-data.mjs';
import * as bossRally from '../services/boss-rally.mjs';
import { optimizeForMonster } from '../services/gear-optimizer.mjs';
import { applyGearLoadout } from '../services/gear-loadout.mjs';
import { findBestTeam, buildFakeCharacterWithLoadout } from '../services/event-simulation.mjs';
import { scoreHealingItems, restUntil } from '../services/food-manager.mjs';
import { moveTo, parseFightResult, depositAll } from '../helpers.mjs';
import { getOwnedKeepByCodeForInventory } from '../services/gear-state.mjs';
import { withdrawBankItems } from '../services/bank-ops.mjs';
import { getBankSummary } from '../services/inventory-manager.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';

const TAG = 'BossFight';
const EVAL_COOLDOWN_MS = 5 * 60_000; // 5 minutes between evaluations

export class BossFightRoutine extends BaseRoutine {
  constructor(cfg) {
    super({
      name: TAG,
      type: cfg.type,
      priority: cfg.priority || 15,
      loop: true,
      urgent: false,
    });
    this.enabled = cfg.enabled !== false;
    this.bossCode = cfg.bossCode || 'king_slime';
    this.teamSize = cfg.teamSize || 3;
    this.minWinrate = cfg.minWinrate ?? 80;
    this.repeat = cfg.repeat !== false;
    this.maxFights = cfg.maxFights || 0; // 0 = unlimited
    this._evalCooldownUntil = 0;
  }

  updateConfig(cfg) {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled !== false;
    if (cfg.bossCode !== undefined) this.bossCode = cfg.bossCode;
    if (cfg.teamSize !== undefined) this.teamSize = cfg.teamSize;
    if (cfg.minWinrate !== undefined) this.minWinrate = cfg.minWinrate;
    if (cfg.repeat !== undefined) this.repeat = cfg.repeat !== false;
    if (cfg.maxFights !== undefined) this.maxFights = cfg.maxFights || 0;
  }

  canBePreempted(ctx) {
    const rally = bossRally.getRally();
    if (!rally || !bossRally.isParticipant(ctx.name)) return true;

    // Don't preempt when a fight result is waiting to be consumed
    if ((rally.phase === 'done' || rally.phase === 'failed')
      && !rally.resultConsumedBy.has(ctx.name)) {
      return false;
    }

    // Don't preempt during between-fight healing (team stays together)
    if (rally.fightCount > 0 && rally.phase === 'rallying') {
      return false;
    }

    return true;
  }

  canRun(ctx) {
    if (!this.enabled) return false;

    // 1. Active rally and this character is participant → join
    if (bossRally.isParticipant(ctx.name)) return true;

    // 2. Eval cooldown gates only leader evaluation, not rally joins
    if (Date.now() < this._evalCooldownUntil) {
      log.debug(`[${TAG}] ${ctx.name}: skipped — eval cooldown (${Math.round((this._evalCooldownUntil - Date.now()) / 1000)}s remaining)`);
      return false;
    }

    // 3. No rally → sync checks for potential leader evaluation
    if (bossRally.isRallyActive()) return false;

    const monster = gameData.getMonster(this.bossCode);
    if (!monster || monster.type !== 'boss') {
      log.debug(`[${TAG}] ${ctx.name}: skipped — monster "${this.bossCode}" not found or type="${monster?.type}" (expected "boss")`);
      return false;
    }

    if (ctx.cooldownRemainingMs() > 0) return false;
    if (ctx.inventoryFull()) return false;

    // Need at least 2 eligible characters (group-only)
    const allContextNames = bossRally.getAllContexts()
      .filter(c => !c.inventoryFull())
      .map(c => c.name);
    if (allContextNames.length < 2) {
      log.debug(`[${TAG}] ${ctx.name}: skipped — only ${allContextNames.length} eligible context(s) registered`);
      return false;
    }

    return true;
  }

  async execute(ctx) {
    const rally = bossRally.getRally();

    // No rally → this character becomes the evaluator
    if (!rally) {
      return this._evaluate(ctx);
    }

    // Rally exists — determine role
    const isLeader = rally.leaderName === ctx.name;

    if (rally.phase === 'rallying' || rally.phase === 'ready') {
      // Check if we still need to rally (equip, food, move, check in)
      if (!rally.checkedIn.has(ctx.name)) {
        // Between-fight re-rally: just heal and check in (already at location with gear)
        if (rally.fightCount > 0) {
          return this._healAndRecheckIn(ctx, rally);
        }
        return this._rally(ctx, rally);
      }

      // Already checked in — leader starts fight when all ready
      if (isLeader && bossRally.allCheckedIn()) {
        return this._fight(ctx, rally);
      }

      // Waiting for others — sleep to avoid rapid polling
      await this._sleep(5000);
      return this._yield(isLeader ? 'rally_waiting' : 'rally_waiting_for_fight', null, true);
    }

    if (rally.phase === 'done' || rally.phase === 'failed') {
      if (isLeader) {
        return this._leaderPostFight(ctx, rally);
      }
      return this._participantPostFight(ctx, rally);
    }

    if (rally.phase === 'fighting') {
      // Fight in progress — wait
      await this._sleep(5000);
      return this._yield('fighting_in_progress', null, true);
    }

    return false;
  }

  // --- EVALUATING (no rally yet) ---

  async _evaluate(ctx) {
    // Get boss location
    const location = await gameData.getMonsterLocation(this.bossCode);
    if (!location) {
      log.warn(`[${TAG}] ${ctx.name}: No location found for ${this.bossCode}`);
      this._evalCooldownUntil = Date.now() + EVAL_COOLDOWN_MS;
      return false;
    }

    // Get all eligible contexts for boss fight
    const allContexts = bossRally.getAllContexts();
    const enabledNames = allContexts.map(c => c.name);
    const eligible = bossRally.getEligibleContexts({ enabledNames });

    if (eligible.length < 2) {
      log.info(`[${TAG}] ${ctx.name}: Not enough eligible characters (${eligible.length})`);
      this._evalCooldownUntil = Date.now() + EVAL_COOLDOWN_MS;
      return false;
    }

    // Run gear optimization for each eligible character
    log.info(`[${TAG}] ${ctx.name}: Evaluating team for ${this.bossCode} (${eligible.length} eligible)`);
    const optimized = new Map(); // name → { loadout, simResult }
    for (const c of eligible) {
      try {
        const result = await optimizeForMonster(c, this.bossCode);
        if (result) {
          optimized.set(c.name, result);
        }
      } catch (err) {
        log.warn(`[${TAG}] Optimizer failed for ${c.name}: ${err.message}`);
      }
    }

    if (optimized.size < 2) {
      log.info(`[${TAG}] ${ctx.name}: Not enough optimized characters (${optimized.size})`);
      this._evalCooldownUntil = Date.now() + EVAL_COOLDOWN_MS;
      return false;
    }

    // Build fake characters with optimized loadouts for team sim
    const fakeCharsByName = new Map();
    for (const [name, { loadout }] of optimized) {
      const c = bossRally.getContext(name);
      if (c) {
        fakeCharsByName.set(name, buildFakeCharacterWithLoadout(c, loadout));
      }
    }

    // Log fake characters for debugging
    for (const [name, fake] of fakeCharsByName) {
      const slots = Object.entries(fake)
        .filter(([k, v]) => k.endsWith('_slot') && v && !k.includes('quantity'))
        .map(([k, v]) => `${k.replace('_slot', '')}=${v}`)
        .join(', ');
      log.debug(`[${TAG}] Sim input ${name} (lv${fake.level}): ${slots || 'no gear'}`);
    }

    const eligibleForSim = eligible.filter(c => optimized.has(c.name));
    const teamResult = await findBestTeam(eligibleForSim, this.bossCode, {
      maxTeamSize: this.teamSize,
      minTeamSize: 2,
      fakeCharsByName,
    });

    if (!teamResult || teamResult.winrate < this.minWinrate) {
      log.info(`[${TAG}] ${ctx.name}: Team winrate ${teamResult?.winrate ?? 0}% < ${this.minWinrate}% threshold`);
      this._evalCooldownUntil = Date.now() + EVAL_COOLDOWN_MS;
      return false;
    }

    log.info(`[${TAG}] ${ctx.name}: Best team [${teamResult.team.map(c => c.name).join(', ')}] at ${teamResult.winrate}% winrate`);

    const teamNames = teamResult.team.map(c => c.name);

    // Gear deconfliction for the winning team
    const loadouts = await this._deconflictGear(teamNames, optimized);

    // Re-sim with deconflicted loadouts if any changed
    let finalWinrate = teamResult.winrate;
    const anyChanged = teamNames.some(name => {
      const orig = optimized.get(name)?.loadout;
      const decon = loadouts.get(name);
      if (!orig || !decon) return false;
      for (const [slot, code] of decon) {
        if ((orig.get(slot)?.code || orig.get(slot) || null) !== code) return true;
      }
      return false;
    });

    if (anyChanged) {
      const reFakeChars = new Map();
      for (const name of teamNames) {
        const c = bossRally.getContext(name);
        if (c) {
          reFakeChars.set(name, buildFakeCharacterWithLoadout(c, loadouts.get(name)));
        }
      }
      const reResult = await findBestTeam(
        teamResult.team, this.bossCode,
        { maxTeamSize: teamNames.length, minTeamSize: teamNames.length, fakeCharsByName: reFakeChars },
      );
      if (reResult) {
        finalWinrate = reResult.winrate;
        if (finalWinrate < this.minWinrate) {
          log.info(`[${TAG}] ${ctx.name}: Deconflicted winrate ${finalWinrate}% < ${this.minWinrate}% threshold`);
          this._evalCooldownUntil = Date.now() + EVAL_COOLDOWN_MS;
          return false;
        }
      }
    }

    // Create rally — leader is first team member, evaluator steps aside if not on team
    const leaderName = teamNames[0];
    const participants = teamNames.slice(1);
    const newRally = bossRally.tryCreateRally({
      bossCode: this.bossCode,
      location,
      leaderName,
      participants,
      loadouts,
    });

    if (!newRally) {
      // Lost CAS race — check if we're a participant of the rally someone else created
      if (bossRally.isParticipant(ctx.name)) {
        return true; // Continue to rallying phase
      }
      return false;
    }

    // Only rally if evaluator is part of the team
    if (teamNames.includes(ctx.name)) {
      return this._rally(ctx, newRally);
    }
    // Evaluator not on team — step aside, let team members handle it
    return false;
  }

  // --- Gear deconfliction ---

  async _deconflictGear(teamNames, optimized) {
    const finalLoadouts = new Map();
    const excludeBank = new Map();

    for (const name of teamNames) {
      const opt = optimized.get(name);
      if (!opt) continue;

      // Re-optimize with excluded bank items (except first character)
      let loadout;
      if (excludeBank.size > 0) {
        const ctx = bossRally.getContext(name);
        if (ctx) {
          try {
            const reOpt = await optimizeForMonster(ctx, this.bossCode, { excludeBank });
            loadout = this._extractLoadoutCodes(reOpt?.loadout || opt.loadout);
          } catch {
            loadout = this._extractLoadoutCodes(opt.loadout);
          }
        } else {
          loadout = this._extractLoadoutCodes(opt.loadout);
        }
      } else {
        loadout = this._extractLoadoutCodes(opt.loadout);
      }

      finalLoadouts.set(name, loadout);

      // Track bank items claimed by this character
      for (const [, code] of loadout) {
        if (code) {
          excludeBank.set(code, (excludeBank.get(code) || 0) + 1);
        }
      }
    }

    return finalLoadouts;
  }

  /**
   * Extract slot → itemCode map from optimizer loadout (which may contain item objects).
   */
  _extractLoadoutCodes(loadout) {
    const codes = new Map();
    for (const [slot, val] of loadout) {
      codes.set(slot, val?.code || val || null);
    }
    return codes;
  }

  // --- RALLYING ---

  async _rally(ctx, rally) {
    const loadout = rally.loadouts.get(ctx.name);

    // Deposit non-essential inventory to make room for gear swaps
    if (ctx.inventoryCount() > 0) {
      const keepByCode = getOwnedKeepByCodeForInventory(ctx);
      // Also keep items from the boss fight loadout
      if (loadout) {
        for (const [, code] of loadout) {
          if (code) keepByCode[code] = Math.max(keepByCode[code] || 0, 1);
        }
      }
      await depositAll(ctx, {
        reason: `boss fight prep for ${rally.bossCode}`,
        keepByCode,
      });
    }

    // Apply gear loadout
    if (loadout) {
      await applyGearLoadout(ctx, loadout, {
        reason: `boss fight gear for ${rally.bossCode}`,
        abortOnMissing: false,
      });
    }

    // Withdraw food from bank and register keep-codes
    await this._withdrawFood(ctx);

    // Rest to full HP
    await restUntil(ctx, 100);

    // Move to boss location
    if (api.isShuttingDown()) return false;
    await moveTo(ctx, rally.location.x, rally.location.y);

    // Check in
    bossRally.checkIn(ctx.name);

    // If all checked in and we're the leader, start fight
    if (bossRally.allCheckedIn() && rally.leaderName === ctx.name) {
      bossRally.setPhase('ready');
      return this._fight(ctx, rally);
    }

    await this._sleep(5000);
    return this._yield('rally_waiting', null, true);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _withdrawFood(ctx) {
    const bankSummary = getBankSummary({ includeItems: true });
    if (!bankSummary?.items) return;

    const character = ctx.get();
    const bankFoods = scoreHealingItems(bankSummary.items, character);

    if (bankFoods.length === 0) return;

    // Fill available inventory space with best food
    const freeSpace = ctx.inventoryCapacity() - ctx.inventoryCount();
    if (freeSpace <= 0) return;

    const toWithdraw = [];
    let remaining = freeSpace;
    for (const food of bankFoods) {
      if (remaining <= 0) break;
      const qty = Math.min(food.quantity, remaining);
      if (qty > 0) {
        toWithdraw.push({ code: food.code, quantity: qty });
        remaining -= qty;
      }
    }

    if (toWithdraw.length === 0) return;

    const result = await withdrawBankItems(ctx, toWithdraw, {
      reason: `boss fight food for ${this.bossCode}`,
      mode: 'partial',
      retryStaleOnce: true,
    });
    logWithdrawalWarnings(ctx, result, 'BossFood');

    // Register keep-codes
    const keepCodes = { ...(ctx.getRoutineKeepCodes() || {}) };
    for (const w of toWithdraw) {
      if (w.quantity > 0) {
        keepCodes[w.code] = (keepCodes[w.code] || 0) + w.quantity;
      }
    }
    ctx.setRoutineKeepCodes(keepCodes);
  }

  // --- FIGHTING (leader) ---

  async _fight(ctx, rally) {
    bossRally.setPhase('fighting');

    const participants = rally.participants;
    const fightNum = (rally.fightCount || 0) + 1;
    log.info(`[${TAG}] ${ctx.name} initiating fight #${fightNum} vs ${rally.bossCode} with [${participants.join(', ')}]`);

    try {
      const result = await api.fight(ctx.name, { participants });
      ctx.applyActionResult(result);

      const fightData = parseFightResult(result, ctx);
      const phase = fightData.win ? 'done' : 'failed';

      // Publish result before cooldown wait
      bossRally.setFightResult(result);
      bossRally.setPhase(phase);
      bossRally.markResultConsumed(ctx.name);

      log.info(`[${TAG}] Fight #${fightNum} ${fightData.win ? 'WON' : 'LOST'}: ${fightData.turns} turns, +${fightData.xp}xp, +${fightData.gold}g${fightData.drops ? `, drops: ${fightData.drops}` : ''}`);

      await api.waitForCooldown(result);

      return this._leaderPostFight(ctx, rally);
    } catch (err) {
      log.error(`[${TAG}] Fight failed: ${err.message}`);
      bossRally.setPhase('failed');
      bossRally.cancelRally(`fight error: ${err.message}`);
      return false;
    }
  }

  // --- Leader post-fight ---

  _shouldContinueFighting(rally) {
    if (!this.repeat) return false;
    if (this.maxFights > 0 && (rally.fightCount || 0) + 1 >= this.maxFights) return false;
    if (api.isShuttingDown()) return false;
    // Don't loop on losses
    if (rally.phase === 'failed') return false;
    return true;
  }

  async _leaderPostFight(ctx, rally) {
    if (!this._shouldContinueFighting(rally)) {
      const reason = rally.phase === 'failed'
        ? 'fight lost, re-evaluating'
        : this.maxFights > 0 && (rally.fightCount || 0) + 1 >= this.maxFights
          ? `reached ${this.maxFights} fight limit`
          : 'fight complete (no repeat)';
      bossRally.cancelRally(reason);
      return false;
    }

    // Wait for all participants to consume the fight result before resetting
    let waitAttempts = 0;
    while (!bossRally.allResultsConsumed() && waitAttempts < 30) {
      await this._sleep(1000);
      waitAttempts++;
      if (api.isShuttingDown()) return false;
    }

    if (!bossRally.allResultsConsumed()) {
      log.warn(`[${TAG}] Not all participants consumed result after 30s, cancelling rally`);
      bossRally.cancelRally('participant timeout on result consumption');
      return false;
    }

    // Reset rally for next fight (keeps team, gear, location intact)
    bossRally.resetForNextFight();

    // Leader heals and re-checks-in
    return this._healAndRecheckIn(ctx, bossRally.getRally());
  }

  // --- Participant post-fight ---

  async _participantPostFight(ctx, rally) {
    // Already consumed — wait for leader to reset or cancel rally
    if (rally.resultConsumedBy.has(ctx.name)) {
      await this._sleep(5000);
      return this._yield('awaiting_rally_cleanup', null, true);
    }

    const result = rally.fightResult;
    bossRally.markResultConsumed(ctx.name);

    if (result) {
      ctx.applyActionResult(result);

      const fightData = parseFightResult(result, ctx);
      log.info(`[${TAG}] ${ctx.name} (participant): ${fightData.win ? 'WON' : 'LOST'}, +${fightData.xp}xp, +${fightData.gold}g${fightData.drops ? `, drops: ${fightData.drops}` : ''}`);

      const remainingMs = ctx.cooldownRemainingMs();
      if (remainingMs > 0) {
        await api.waitForCooldown({
          cooldown: { remaining_seconds: remainingMs / 1000 },
        });
      }
    }

    // Stay in loop — leader will either resetForNextFight or cancelRally.
    // Don't clear keep-codes (food still needed for next fight).
    // When rally is cancelled, cancelRally() clears keep-codes for all participants.
    await this._sleep(5000);
    return this._yield('result_consumed_awaiting_next', null, true);
  }

  // --- Between-fight healing ---

  async _healAndRecheckIn(ctx, rally) {
    // Stretch goal: request food from teammates if we have none
    await this._tradeFoodIfNeeded(ctx, rally);

    // Eat food first, then fall back to rest API
    await restUntil(ctx, 100);

    if (api.isShuttingDown()) return false;

    // Safety: verify still at boss location
    if (!ctx.isAt(rally.location.x, rally.location.y)) {
      await moveTo(ctx, rally.location.x, rally.location.y);
    }

    bossRally.checkIn(ctx.name);

    if (bossRally.allCheckedIn() && rally.leaderName === ctx.name) {
      bossRally.setPhase('ready');
      return this._fight(ctx, rally);
    }

    await this._sleep(5000);
    return this._yield('rally_waiting_between_fights', null, true);
  }

  async _tradeFoodIfNeeded(ctx, rally) {
    // Only trade if this character needs HP and has no healing food
    if (ctx.hpPercent() >= 80) return;

    const character = ctx.get();
    const myFood = scoreHealingItems(character.inventory || [], character);
    if (myFood.length > 0) return;

    // Find a teammate with food they can share
    const allNames = [rally.leaderName, ...rally.participants];
    for (const name of allNames) {
      if (name === ctx.name) continue;
      const teammate = bossRally.getContext(name);
      if (!teammate) continue;

      const tc = teammate.get();
      // Must be at same location for give_item API
      if (tc.x !== character.x || tc.y !== character.y) continue;

      // Score teammate's food using OUR character's level requirements
      const theirFood = scoreHealingItems(tc.inventory || [], character);
      if (theirFood.length === 0) continue;

      const bestFood = theirFood[0];
      const hpNeeded = character.max_hp - character.hp;
      const countNeeded = Math.ceil(hpNeeded / bestFood.hpRestore);
      // Take at most half their supply
      const countToGive = Math.min(countNeeded, Math.floor(bestFood.quantity / 2));
      if (countToGive <= 0) continue;

      try {
        log.info(`[${TAG}] ${name} giving ${bestFood.code} x${countToGive} to ${ctx.name}`);
        const result = await api.giveItem(
          [{ code: bestFood.code, quantity: countToGive }],
          ctx.name,
          name,
        );
        // Update donor state
        teammate.applyActionResult(result);
        await api.waitForCooldown(result);
        // Refresh receiver state to pick up new inventory
        await ctx.refresh();
        break;
      } catch (err) {
        log.warn(`[${TAG}] Food trade from ${name} to ${ctx.name} failed: ${err.message}`);
      }
    }
  }
}
