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
import { getOrderBoardSnapshot } from '../services/order-board.mjs';
import { optimizeForMonster, optimizeForRole } from '../services/gear-optimizer.mjs';
import { applyGearLoadout } from '../services/gear-loadout.mjs';
import { findBestTeam, buildFakeCharacterWithLoadout, combinations } from '../services/event-simulation.mjs';
import { scoreHealingItems, restUntil } from '../services/food-manager.mjs';
import { moveTo, parseFightResult, depositAll } from '../helpers.mjs';
import { getOwnedKeepByCodeForInventory } from '../services/gear-state.mjs';
import { withdrawBankItems } from '../services/bank-ops.mjs';
import { getBankSummary } from '../services/inventory-manager.mjs';
import { logWithdrawalWarnings } from '../utils.mjs';

const TAG = 'BossFight';
const EVAL_COOLDOWN_MS = 5 * 60_000; // 5 minutes between evaluations

const ALL_BOSS_CODES = [
  'king_slime',
  'lich',
  'goblin_priestess',
  'cultist_emperor',
  'rosenblood',
  'duskworm',
  'sandwhisper_empress',
];

export class BossFightRoutine extends BaseRoutine {
  constructor(cfg) {
    super({
      name: TAG,
      type: cfg.type,
      priority: cfg.priority || 15,
      loop: true,
      urgent: false,
    });
    this.teamSize = cfg.teamSize || 3;
    this.repeat = cfg.repeat !== false;
    this.maxFights = cfg.maxFights || 0; // 0 = unlimited
    this.orderDriven = cfg.orderDriven === true;
    this.bosses = this._normalizeBosses(cfg);
    this.enabledBossCodes = this.bosses.filter(b => b.enabled).map(b => b.code);
    this._evalCooldownUntil = new Map(); // bossCode → timestamp
  }

  /**
   * Normalize config into bosses array. Handles legacy single-bossCode format.
   */
  _normalizeBosses(cfg) {
    if (Array.isArray(cfg.bosses)) return cfg.bosses;
    // Legacy migration: single bossCode → bosses array
    if (cfg.bossCode) {
      return ALL_BOSS_CODES.map(code => ({
        code,
        enabled: code === cfg.bossCode ? (cfg.enabled !== false) : false,
        minWinrate: code === cfg.bossCode ? (cfg.minWinrate ?? 80) : 80,
      }));
    }
    // Default: all disabled
    return ALL_BOSS_CODES.map(code => ({ code, enabled: false, minWinrate: 80 }));
  }

  updateConfig(cfg) {
    if (cfg.teamSize !== undefined) this.teamSize = cfg.teamSize;
    if (cfg.repeat !== undefined) this.repeat = cfg.repeat !== false;
    if (cfg.maxFights !== undefined) this.maxFights = cfg.maxFights || 0;
    if (cfg.orderDriven !== undefined) this.orderDriven = cfg.orderDriven === true;
    if (cfg.bosses !== undefined) {
      this.bosses = Array.isArray(cfg.bosses) ? cfg.bosses : this._normalizeBosses(cfg);
      this.enabledBossCodes = this.bosses.filter(b => b.enabled).map(b => b.code);
    }
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
    if (this.enabledBossCodes.length === 0) return false;

    // Register enabled bosses for team filtering
    bossRally.registerEnabledBosses(ctx.name, this.enabledBossCodes);

    // 1. Active rally and this character is participant → join
    if (bossRally.isParticipant(ctx.name)) return true;

    // 2. Check if ANY enabled boss is past eval cooldown
    const now = Date.now();
    const runnableBossCodes = this.enabledBossCodes.filter(code =>
      now >= (this._evalCooldownUntil.get(code) || 0),
    );
    if (runnableBossCodes.length === 0) {
      log.debug(`[${TAG}] ${ctx.name}: skipped — all bosses on eval cooldown`);
      return false;
    }

    if (this.orderDriven) {
      const hasMatchingOrders = runnableBossCodes.some(code => this._ordersRequireBoss(code));
      if (!hasMatchingOrders) {
        log.debug(`[${TAG}] ${ctx.name}: skipped — no matching orders for enabled bosses (order-driven mode)`);
        return false;
      }
    }

    // 3. No rally → sync checks for potential leader evaluation
    if (bossRally.isRallyActive()) return false;
    if (bossRally.isEvaluating()) return false;
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
    if (!bossRally.tryStartEvaluation(ctx.name)) return false;
    try {
      const now = Date.now();
      for (const boss of this.bosses) {
        if (!boss.enabled) continue;
        if (now < (this._evalCooldownUntil.get(boss.code) || 0)) continue;

        // Order-driven check
        if (this.orderDriven && !this._ordersRequireBoss(boss.code)) {
          log.debug(`[${TAG}] ${ctx.name}: skipping ${boss.code} — no matching orders (order-driven mode)`);
          continue;
        }

        const result = await this._evaluateBoss(ctx, boss.code, boss.minWinrate);
        if (result) return result;
        // _evaluateBoss sets per-boss cooldown on failure
      }
      return false;
    } finally {
      bossRally.endEvaluation(ctx.name);
    }
  }

  /**
   * Check if the order board has any active order requiring drops from this boss.
   * Checks direct fight orders, orders for boss drop items, and craft orders
   * whose recipe chain transitively requires boss drops.
   */
  _ordersRequireBoss(bossCode) {
    const boss = gameData.getMonster(bossCode);
    if (!boss?.drops) return false;

    const bossDropCodes = new Set(boss.drops.map(d => d.code));
    let snapshot;
    try {
      snapshot = getOrderBoardSnapshot();
    } catch {
      return false; // Order board not initialized
    }
    if (!snapshot?.orders) return false;

    for (const order of snapshot.orders) {
      if (order.status === 'fulfilled') continue;
      if ((order.remainingQty || 0) <= 0) continue;

      // Direct fight order for this boss
      if (order.sourceType === 'fight' && order.sourceCode === bossCode) return true;

      // Order for an item that IS a boss drop
      if (bossDropCodes.has(order.itemCode)) return true;

      // Craft order whose recipe needs a boss drop
      if (order.sourceType === 'craft') {
        const item = gameData.getItem(order.itemCode);
        if (item?.craft) {
          const chain = gameData.resolveRecipeChain(item.craft);
          if (chain?.some(step => bossDropCodes.has(step.itemCode))) return true;
        }
      }
    }
    return false;
  }

  /**
   * Evaluate a specific boss: optimize gear with roles, find best team, create rally.
   * Returns truthy if a rally was created/joined, false otherwise.
   * Sets per-boss eval cooldown on failure.
   */
  async _evaluateBoss(ctx, bossCode, minWinrate) {
    // Get boss location
    const location = await gameData.getMonsterLocation(bossCode);
    if (!location) {
      log.warn(`[${TAG}] ${ctx.name}: No location found for ${bossCode}`);
      this._evalCooldownUntil.set(bossCode, Date.now() + EVAL_COOLDOWN_MS);
      return false;
    }

    // Get all eligible contexts for this boss
    const allContexts = bossRally.getAllContexts();
    const enabledNames = allContexts.map(c => c.name);
    const eligible = bossRally.getEligibleContexts({ enabledNames, bossCode, ignoreCooldown: true });

    if (eligible.length < 2) {
      log.info(`[${TAG}] ${ctx.name}: Not enough eligible characters for ${bossCode} (${eligible.length})`);
      this._evalCooldownUntil.set(bossCode, Date.now() + EVAL_COOLDOWN_MS);
      return false;
    }

    // Run role-based gear optimization for each eligible character
    log.info(`[${TAG}] ${ctx.name}: Evaluating team for ${bossCode} (${eligible.length} eligible, role-based)`);
    const tankLoadouts = new Map(); // name → { loadout, simResult, gearThreat }
    const dpsLoadouts = new Map();  // name → { loadout, simResult, gearThreat }

    for (const c of eligible) {
      try {
        const tankResult = await optimizeForRole(c, bossCode, 'tank');
        if (tankResult) tankLoadouts.set(c.name, tankResult);
      } catch (err) {
        log.warn(`[${TAG}] Tank optimizer failed for ${c.name}: ${err.message}`);
      }
      try {
        const dpsResult = await optimizeForRole(c, bossCode, 'dps');
        if (dpsResult) dpsLoadouts.set(c.name, dpsResult);
      } catch (err) {
        log.warn(`[${TAG}] DPS optimizer failed for ${c.name}: ${err.message}`);
      }
    }

    // Need at least 2 characters with both loadouts
    const fullyOptimized = eligible.filter(c => tankLoadouts.has(c.name) && dpsLoadouts.has(c.name));
    if (fullyOptimized.length < 2) {
      log.info(`[${TAG}] ${ctx.name}: Not enough optimized characters for ${bossCode} (${fullyOptimized.length})`);
      this._evalCooldownUntil.set(bossCode, Date.now() + EVAL_COOLDOWN_MS);
      return false;
    }

    // Find best role-based team via server-side simulation
    const roleTeamResult = await this._findBestRoleTeam(
      fullyOptimized, bossCode, tankLoadouts, dpsLoadouts,
    );

    if (!roleTeamResult || roleTeamResult.winrate < minWinrate) {
      log.info(`[${TAG}] ${ctx.name}: Team winrate ${roleTeamResult?.winrate ?? 0}% < ${minWinrate}% threshold for ${bossCode}`);
      this._evalCooldownUntil.set(bossCode, Date.now() + EVAL_COOLDOWN_MS);
      return false;
    }

    const { team, winrate, roles, loadouts: teamLoadouts } = roleTeamResult;
    const teamNames = team.map(c => c.name);
    const tankName = [...roles].find(([, r]) => r === 'tank')?.[0];

    log.info(`[${TAG}] ${ctx.name}: Best team [${teamNames.join(', ')}] at ${winrate}% winrate for ${bossCode} (tank=${tankName}, threat=${tankLoadouts.get(tankName)?.gearThreat ?? 0})`);

    // Gear deconfliction — tank gets first pick
    const deconflicted = await this._deconflictGear(teamNames, roles, tankLoadouts, dpsLoadouts, bossCode);

    // Re-sim with deconflicted loadouts if any changed
    let finalWinrate = winrate;
    const anyChanged = teamNames.some(name => {
      const orig = teamLoadouts.get(name);
      const decon = deconflicted.get(name);
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
        if (c) reFakeChars.set(name, buildFakeCharacterWithLoadout(c, deconflicted.get(name)));
      }
      try {
        const fakeChars = teamNames.map(n => reFakeChars.get(n));
        const response = await api.simulateFight({
          characters: fakeChars,
          monster: bossCode,
          iterations: 10,
        });
        finalWinrate = response.winrate ?? 0;
        if (finalWinrate < minWinrate) {
          log.info(`[${TAG}] ${ctx.name}: Deconflicted winrate ${finalWinrate}% < ${minWinrate}% threshold for ${bossCode}`);
          this._evalCooldownUntil.set(bossCode, Date.now() + EVAL_COOLDOWN_MS);
          return false;
        }
      } catch (err) {
        log.warn(`[${TAG}] Re-sim failed: ${err.message}, using original winrate`);
      }
    }

    // Create rally — leader is first team member, evaluator steps aside if not on team
    const leaderName = teamNames[0];
    const participants = teamNames.slice(1);
    const newRally = bossRally.tryCreateRally({
      bossCode,
      location,
      leaderName,
      participants,
      loadouts: deconflicted,
      roles,
    });

    if (!newRally) {
      if (bossRally.isParticipant(ctx.name)) {
        return true;
      }
      return false;
    }

    if (teamNames.includes(ctx.name)) {
      return this._rally(ctx, newRally);
    }
    return false;
  }

  /**
   * Find the best role-based team: try all team combos × tank assignments,
   * simulate each via server API, return the best.
   */
  async _findBestRoleTeam(eligible, bossCode, tankLoadouts, dpsLoadouts) {
    let bestResult = null;

    const maxSize = Math.min(this.teamSize, eligible.length);
    const minSize = Math.min(2, eligible.length);

    for (let size = minSize; size <= maxSize; size++) {
      const combos = combinations(eligible, size);
      for (const team of combos) {
        // Try each character as tank
        for (const tankCtx of team) {
          const tankName = tankCtx.name;
          const tankOpt = tankLoadouts.get(tankName);
          if (!tankOpt) continue;

          const fakeChars = [];
          const teamLoadouts = new Map();
          const roles = new Map();
          let valid = true;

          for (const c of team) {
            if (c.name === tankName) {
              fakeChars.push(buildFakeCharacterWithLoadout(c, tankOpt.loadout));
              teamLoadouts.set(c.name, tankOpt.loadout);
              roles.set(c.name, 'tank');
            } else {
              const dpsOpt = dpsLoadouts.get(c.name);
              if (!dpsOpt) { valid = false; break; }
              fakeChars.push(buildFakeCharacterWithLoadout(c, dpsOpt.loadout));
              teamLoadouts.set(c.name, dpsOpt.loadout);
              roles.set(c.name, 'dps');
            }
          }
          if (!valid) continue;

          try {
            const response = await api.simulateFight({
              characters: fakeChars,
              monster: bossCode,
              iterations: 10,
            });
            const winrate = response.winrate ?? 0;
            log.debug(`[${TAG}] Role team [${team.map(c => c.name).join(', ')}] tank=${tankName}: ${winrate}%`);

            if (!bestResult || winrate > bestResult.winrate) {
              bestResult = { team, winrate, roles, loadouts: teamLoadouts };
            }
          } catch (err) {
            log.warn(`[${TAG}] Role team simulation failed: ${err.message}`);
          }
        }
      }
    }

    return bestResult;
  }

  // --- Gear deconfliction ---

  async _deconflictGear(teamNames, roles, tankLoadouts, dpsLoadouts, bossCode) {
    const finalLoadouts = new Map();
    const excludeBank = new Map();

    // Sort so tank goes first — gets priority on threat/survivability items
    const sorted = [...teamNames].sort((a, b) => {
      const aRole = roles.get(a) || 'dps';
      const bRole = roles.get(b) || 'dps';
      if (aRole === 'tank' && bRole !== 'tank') return -1;
      if (aRole !== 'tank' && bRole === 'tank') return 1;
      return 0;
    });

    for (const name of sorted) {
      const role = roles.get(name) || 'dps';
      const origLoadouts = role === 'tank' ? tankLoadouts : dpsLoadouts;
      const opt = origLoadouts.get(name);
      if (!opt) continue;

      const ctx = bossRally.getContext(name);
      let loadout;
      if (excludeBank.size > 0 && ctx) {
        try {
          const reOpt = await optimizeForRole(ctx, bossCode, role, { excludeBank });
          loadout = this._extractLoadoutCodes(reOpt?.loadout || opt.loadout);
        } catch {
          loadout = this._extractLoadoutCodes(opt.loadout);
        }
      } else {
        loadout = this._extractLoadoutCodes(opt.loadout);
      }

      finalLoadouts.set(name, loadout);

      // Only exclude items that must come from the bank — skip items already equipped or in inventory
      const char = ctx?.get();
      for (const [slot, code] of loadout) {
        if (!code) continue;
        if (char && char[`${slot}_slot`] === code) continue;
        if (ctx?.hasItem(code)) continue;
        excludeBank.set(code, (excludeBank.get(code) || 0) + 1);
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
    await this._withdrawFood(ctx, rally.bossCode);

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

  async _withdrawFood(ctx, bossCode) {
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
      reason: `boss fight food for ${bossCode}`,
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
