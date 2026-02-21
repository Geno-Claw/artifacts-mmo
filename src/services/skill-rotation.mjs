/**
 * Skill rotation state manager.
 * Randomly cycles between skills (mining, woodcutting, fishing, cooking,
 * alchemy, combat, npc_task) with goal-based durations.
 */
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { findBestCombatTarget, optimizeForMonster } from './gear-optimizer.mjs';
import { createOrMergeOrder } from './order-board.mjs';

const GATHERING_SKILLS = new Set(['mining', 'woodcutting', 'fishing']);
const CRAFTING_SKILLS = new Set(['cooking', 'alchemy', 'weaponcrafting', 'gearcrafting', 'jewelrycrafting']);

const DEFAULT_GOALS = {
  mining: 20,
  woodcutting: 20,
  fishing: 20,
  cooking: 5,
  alchemy: 5,
  weaponcrafting: 2,
  gearcrafting: 2,
  jewelrycrafting: 2,
  combat: 10,
  npc_task: 999,
  item_task: 999,
};

const DEFAULT_ORDER_BOARD = Object.freeze({
  enabled: false,
  createOrders: false,
  fulfillOrders: false,
  leaseMs: 120_000,
  blockedRetryMs: 600_000,
});
const DEFAULT_RECIPE_BLOCK_MS = 120_000;

function normalizeOrderBoardConfig(cfg = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const enabled = raw.enabled === true;
  const leaseMs = Number(raw.leaseMs);
  const blockedRetryMs = Number(raw.blockedRetryMs);
  const createOrders = typeof raw.createOrders === 'boolean' ? raw.createOrders : enabled;
  const fulfillOrders = typeof raw.fulfillOrders === 'boolean' ? raw.fulfillOrders : enabled;

  return {
    enabled,
    createOrders,
    fulfillOrders,
    leaseMs: Number.isFinite(leaseMs) && leaseMs > 0 ? Math.floor(leaseMs) : DEFAULT_ORDER_BOARD.leaseMs,
    blockedRetryMs: Number.isFinite(blockedRetryMs) && blockedRetryMs > 0
      ? Math.floor(blockedRetryMs)
      : DEFAULT_ORDER_BOARD.blockedRetryMs,
  };
}

export class SkillRotation {
  constructor(
    {
      skills,
      goals = {},
      weights,
      craftBlacklist = {},
      taskCollection = {},
      orderBoard = {},
      recipeBlockMs = DEFAULT_RECIPE_BLOCK_MS,
    } = {},
    {
      gameDataSvc = gameData,
      findBestCombatTargetFn = findBestCombatTarget,
      optimizeForMonsterFn = optimizeForMonster,
      createOrMergeOrderFn = createOrMergeOrder,
    } = {},
  ) {
    if (weights && Object.keys(weights).length > 0) {
      this.weights = weights;
      this.skills = Object.keys(weights).filter(s => weights[s] > 0);
    } else {
      this.skills = skills?.length > 0 ? skills : Object.keys(DEFAULT_GOALS);
      this.weights = null;
    }
    this.goals = { ...DEFAULT_GOALS, ...goals };
    this.craftBlacklist = craftBlacklist;          // { skill: string[] }
    this.taskCollection = taskCollection;          // { itemCode: targetQty } manual targets
    this.gameData = gameDataSvc;
    this.findBestCombatTarget = findBestCombatTargetFn;
    this.optimizeForMonster = optimizeForMonsterFn;
    this.createOrMergeOrder = createOrMergeOrderFn;
    this.orderBoard = normalizeOrderBoardConfig(orderBoard);
    const parsedRecipeBlockMs = Number(recipeBlockMs);
    this.recipeBlockMs = Number.isFinite(parsedRecipeBlockMs) && parsedRecipeBlockMs > 0
      ? Math.floor(parsedRecipeBlockMs)
      : DEFAULT_RECIPE_BLOCK_MS;
    this._exchangeNeeds = new Map();              // { itemCode → qty } dynamic targets from crafting
    this._recipeBlocks = new Map();               // { "skill:recipeCode" → expiresAtMs }

    // Current rotation state
    this.currentSkill = null;
    this.goalProgress = 0;
    this.goalTarget = 0;

    // Skill-specific state (reset each rotation)
    this._resource = null;      // resource object for gathering
    this._resourceLoc = null;   // { x, y } for gathering
    this._recipe = null;        // item object for crafting
    this._productionPlan = null; // resolved recipe chain steps
    this._planStepProgress = null; // tracks gathered quantities per step
    this._monster = null;       // monster object for combat
    this._monsterLoc = null;    // { x, y } for combat
    this._combatLoadout = null; // optimal gear loadout for combat target
    this._bankChecked = false;  // whether bank withdrawal happened for current recipe
  }

  /** Hot-reload: update config fields, preserving rotation state. */
  updateConfig({ weights, skills, goals, craftBlacklist, taskCollection, orderBoard, recipeBlockMs } = {}) {
    if (weights !== undefined) {
      this.weights = weights && Object.keys(weights).length > 0 ? weights : null;
      this.skills = this.weights
        ? Object.keys(this.weights).filter(s => this.weights[s] > 0)
        : (skills?.length > 0 ? skills : Object.keys(DEFAULT_GOALS));
    } else if (skills !== undefined) {
      this.skills = skills?.length > 0 ? skills : Object.keys(DEFAULT_GOALS);
    }
    if (goals !== undefined) this.goals = { ...DEFAULT_GOALS, ...goals };
    if (craftBlacklist !== undefined) this.craftBlacklist = craftBlacklist;
    if (taskCollection !== undefined) this.taskCollection = taskCollection;
    if (orderBoard !== undefined) this.orderBoard = normalizeOrderBoardConfig(orderBoard);
    if (recipeBlockMs !== undefined) {
      const parsed = Number(recipeBlockMs);
      this.recipeBlockMs = Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed) : DEFAULT_RECIPE_BLOCK_MS;
    }
  }

  isGoalComplete() {
    return this.currentSkill !== null && this.goalProgress >= this.goalTarget;
  }

  recordProgress(n = 1) {
    this.goalProgress += n;
  }

  /** Pick the next random skill and set up its state. */
  async pickNext(ctx) {
    this._pruneRecipeBlocks();
    this._resetState();
    this._exchangeNeeds.clear(); // rebuild dynamic targets from crafting setup

    const shuffled = this._weightedShuffle(this.skills);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this.goals[skill] || DEFAULT_GOALS[skill] || 50;
        this.goalProgress = 0;
        return skill;
      }
    }

    // Nothing viable — fallback to first skill (will be caught in execute)
    log.warn(`[${ctx.name}] Rotation: no viable skill found, will idle`);
    this.currentSkill = null;
    return null;
  }

  /** Force rotation to a different skill (e.g., after combat loss). */
  async forceRotate(ctx) {
    const prev = this.currentSkill;
    this._pruneRecipeBlocks();
    this._resetState();

    const others = this.skills.filter(s => s !== prev);
    const shuffled = this._weightedShuffle(others);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this.goals[skill] || DEFAULT_GOALS[skill] || 50;
        this.goalProgress = 0;
        return skill;
      }
    }

    // Nothing else viable — stay on same skill or null
    this.currentSkill = null;
    return null;
  }

  // --- Accessors for skill-specific state ---

  get resource() { return this._resource; }
  get resourceLoc() { return this._resourceLoc; }
  get recipe() { return this._recipe; }
  get productionPlan() { return this._productionPlan; }
  get planStepProgress() { return this._planStepProgress; }
  get monster() { return this._monster; }
  get monsterLoc() { return this._monsterLoc; }
  get combatLoadout() { return this._combatLoadout; }
  get bankChecked() { return this._bankChecked; }
  set bankChecked(v) { this._bankChecked = v; }

  // --- Internal ---

  _resetState() {
    this._resource = null;
    this._resourceLoc = null;
    this._recipe = null;
    this._productionPlan = null;
    this._planStepProgress = null;
    this._monster = null;
    this._monsterLoc = null;
    this._combatLoadout = null;
    this._bankChecked = false;
  }

  _weightedShuffle(skills) {
    if (!this.weights) {
      return [...skills].sort(() => Math.random() - 0.5);
    }
    return [...skills]
      .map(s => ({ skill: s, score: -Math.log(Math.random()) / (this.weights[s] || 1) }))
      .sort((a, b) => a.score - b.score)
      .map(e => e.skill);
  }

  _recipeBlockKey(skill, recipeCode) {
    return `${skill}:${recipeCode}`;
  }

  _pruneRecipeBlocks(now = Date.now()) {
    for (const [key, expiresAt] of this._recipeBlocks) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this._recipeBlocks.delete(key);
      }
    }
  }

  _isRecipeBlocked(skill, recipeCode, now = Date.now()) {
    const key = this._recipeBlockKey(skill, recipeCode);
    const expiresAt = this._recipeBlocks.get(key);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      this._recipeBlocks.delete(key);
      return false;
    }
    return true;
  }

  blockRecipe(skill, recipeCode, { reason = 'temporarily unavailable', durationMs = this.recipeBlockMs, ctx = null } = {}) {
    if (!skill || !recipeCode) return false;
    const ms = Number(durationMs);
    const ttlMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : this.recipeBlockMs;
    const key = this._recipeBlockKey(skill, recipeCode);
    const now = Date.now();
    const prev = this._recipeBlocks.get(key) || 0;
    const next = Math.max(prev, now + ttlMs);

    this._recipeBlocks.set(key, next);
    if (next > prev) {
      const seconds = Math.max(1, Math.ceil((next - now) / 1000));
      const who = ctx?.name ? `[${ctx.name}] ` : '';
      log.info(`${who}Rotation: temporarily blocking ${skill} recipe ${recipeCode} for ${seconds}s (${reason})`);
    }

    return true;
  }

  blockCurrentRecipe({ reason = 'temporarily unavailable', durationMs = this.recipeBlockMs, ctx = null } = {}) {
    if (!this.currentSkill || !this._recipe?.code) return false;
    return this.blockRecipe(this.currentSkill, this._recipe.code, { reason, durationMs, ctx });
  }

  async _setupSkill(skill, ctx) {
    if (skill === 'alchemy') {
      const canCraft = await this._setupCrafting(skill, ctx);
      if (canCraft) return true;

      const canGather = await this._setupGathering(skill, ctx);
      if (canGather) {
        log.info(`[${ctx.name}] Rotation: alchemy crafting unavailable, bootstrapping with gathering`);
        return true;
      }

      return false;
    }

    if (GATHERING_SKILLS.has(skill)) {
      return this._setupGathering(skill, ctx);
    }
    if (CRAFTING_SKILLS.has(skill)) {
      return this._setupCrafting(skill, ctx);
    }
    if (skill === 'combat') {
      return this._setupCombat(ctx);
    }
    if (skill === 'npc_task') {
      return true; // always viable
    }
    if (skill === 'item_task') {
      return true; // always viable
    }
    return false;
  }

  async _setupGathering(skill, ctx) {
    const level = ctx.skillLevel(skill);
    const resources = this.gameData.findResourcesBySkill(skill, level);
    if (resources.length === 0) return false;

    // Pick the highest-level resource
    this._resource = resources[0];
    this._resourceLoc = await this.gameData.getResourceLocation(this._resource.code);
    if (!this._resourceLoc) return false;

    log.info(`[${ctx.name}] Rotation: ${skill} → ${this._resource.code} (lv${this._resource.level})`);
    return true;
  }

  async _setupCrafting(skill, ctx) {
    const level = ctx.skillLevel(skill);
    // Crafting mode now always targets XP/throughput recipes.
    return this._setupXpGrind(skill, level, ctx);
  }

  /**
   * Tier 2: Pick the best recipe for XP grinding.
   * Sorts by craft.level DESC (XP proxy), with bank availability as tiebreaker.
   * Skips blacklisted items and recipes with unmet bank-only dependencies.
   */
  async _setupXpGrind(skill, level, ctx) {
    const recipes = this.gameData.findItems({ craftSkill: skill, maxLevel: level });
    if (recipes.length === 0) return false;

    const bank = await this.gameData.getBankItems();
    const blacklist = new Set(this.craftBlacklist[skill] || []);
    this._pruneRecipeBlocks();

    const scored = [];
    for (const recipe of recipes) {
      if (blacklist.has(recipe.code)) continue;
      if (this._isRecipeBlocked(skill, recipe.code)) continue;

      const candidate = this._buildCraftCandidate(recipe, ctx, bank);
      if (!candidate) continue;
      scored.push(candidate);
    }
    if (scored.length === 0) return false;

    // Verify combat viability for candidates that need monster drops
    const verified = await this._verifyCombatViability(scored, ctx, skill);
    if (verified.length === 0) return false;

    const bankOnlyCandidates = verified.filter(c => c.bankOnly);
    const pool = bankOnlyCandidates.length > 0 ? bankOnlyCandidates : verified;

    // Primary: craft.level DESC (XP proxy), tiebreaker: availability DESC
    pool.sort((a, b) =>
      b.recipe.craft.level - a.recipe.craft.level ||
      b.availability - a.availability
    );

    const best = pool[0];
    this._recipe = best.recipe;
    this._productionPlan = best.plan;
    this._planStepProgress = new Map();
    this._bankChecked = false;

    const bankFirstTag = bankOnlyCandidates.length > 0 ? ', bank-first' : '';
    log.info(`[${ctx.name}] Rotation: ${skill} → XP ${this._recipe.code} (lv${this._recipe.craft.level}, ${best.plan.length} steps, avail: ${(best.availability * 100).toFixed(0)}%${bankFirstTag})`);
    return true;
  }

  /**
   * Score a recipe's production plan by how much of its materials
   * are already available in bank + inventory.
   * Returns 0.0 (nothing available) to 1.0 (everything available).
   */
  _scoreRecipeAvailability(plan, ctx, bank) {
    let totalNeeded = 0;
    let totalHave = 0;

    for (const step of plan) {
      const needed = step.quantity;
      totalNeeded += needed;

      const inInventory = ctx.itemCount(step.itemCode);
      const inBank = bank.get(step.itemCode) || 0;
      totalHave += Math.min(inInventory + inBank, needed);
    }

    return totalNeeded > 0 ? totalHave / totalNeeded : 0;
  }

  /**
   * Build a craft candidate with viability checks and metadata for selection.
   * Returns null if the recipe cannot be used right now.
   */
  _buildCraftCandidate(recipe, ctx, bank) {
    const plan = this.gameData.resolveRecipeChain(recipe.craft);
    if (!plan || plan.length === 0) return null;
    const planCheck = this.gameData.canFulfillPlanWithBank(plan, ctx, bank);
    if (!planCheck.ok) {
      this._queueGatherOrdersForDeficits(plan, recipe, ctx, bank);
      return null;
    }

    // Skip recipes with unmet bank-only dependencies (true bank items — not monster drops)
    const bankSteps = plan.filter(s => s.type === 'bank');
    if (bankSteps.length > 0) {
      const allMet = bankSteps.every(s => (bank.get(s.itemCode) || 0) >= s.quantity);
      if (!allMet) {
        this._trackExchangeNeeds(bankSteps, bank);
        return null;
      }
    }

    // For fight steps: check if bank already has enough (shortcut) or if we need combat viability
    const fightSteps = plan.filter(s => s.type === 'fight');
    let needsCombat = false;
    const fightStepDeficits = [];
    for (const step of fightSteps) {
      const inBank = bank.get(step.itemCode) || 0;
      const inInventory = ctx.itemCount(step.itemCode);
      const deficit = step.quantity - (inBank + inInventory);
      if (deficit > 0) {
        needsCombat = true;
        fightStepDeficits.push({ ...step, deficit });
      }
    }
    // Combat viability is checked async in _buildCraftCandidateAsync — mark it here
    // (the caller will verify combat viability for candidates that need it)

    return {
      recipe,
      plan,
      availability: this._scoreRecipeAvailability(plan, ctx, bank),
      bankOnly: this._isPlanBankOnly(plan, ctx, bank),
      needsCombat,
      fightSteps: needsCombat ? fightStepDeficits : [],
    };
  }

  /**
   * Filter candidates by combat viability — for candidates with fight steps
   * where bank doesn't already cover the requirement, simulate the fight.
   * Candidates that don't need combat pass through unchanged.
   */
  async _verifyCombatViability(candidates, ctx, skill = this.currentSkill) {
    const verified = [];
    // Cache sim results per monster to avoid redundant sims
    const simCache = new Map();

    for (const candidate of candidates) {
      if (!candidate.needsCombat) {
        verified.push(candidate);
        continue;
      }

      let viable = true;
      for (const step of candidate.fightSteps) {
        const monsterCode = step.monster.code;
        if (!simCache.has(monsterCode)) {
          const result = await this.optimizeForMonster(ctx, monsterCode);
          simCache.set(monsterCode, result);
        }
        const simResult = simCache.get(monsterCode);
        if (!simResult || !simResult.simResult.win || simResult.simResult.hpLostPercent > 90) {
          viable = false;
          this._queueFightOrder(step, candidate.recipe, ctx);
          log.info(`[${ctx.name}] Rotation: ${candidate.recipe.code} needs ${step.itemCode} from ${monsterCode} — can't win fight, skipping`);
          if (skill && candidate.recipe?.code) {
            this.blockRecipe(skill, candidate.recipe.code, {
              reason: `combat not viable vs ${monsterCode}`,
              ctx,
            });
          }
          break;
        }
      }
      if (viable) verified.push(candidate);
    }

    return verified;
  }

  _queueGatherOrdersForDeficits(plan, recipe, ctx, bank) {
    const bankItems = bank || new Map();

    for (const step of plan) {
      if (step.type !== 'gather' || !step.resource) continue;
      if (ctx.skillLevel(step.resource.skill) >= step.resource.level) continue;

      const deficit = this._deficitQty(step.quantity, step.itemCode, bankItems, ctx);
      if (deficit <= 0) continue;

      this._enqueueOrder({
        requesterName: ctx.name,
        recipeCode: recipe.code,
        itemCode: step.itemCode,
        sourceType: 'gather',
        sourceCode: step.resource.code,
        gatherSkill: step.resource.skill,
        sourceLevel: step.resource.level,
        quantity: deficit,
      });
    }
  }

  _queueFightOrder(step, recipe, ctx) {
    const qty = Math.max(0, Math.floor(Number(step.deficit || 0)));
    if (qty <= 0) return;

    this._enqueueOrder({
      requesterName: ctx.name,
      recipeCode: recipe.code,
      itemCode: step.itemCode,
      sourceType: 'fight',
      sourceCode: step.monster.code,
      sourceLevel: step.monster.level,
      quantity: qty,
    });
  }

  _enqueueOrder(payload) {
    if (!this.orderBoard.createOrders) return;
    try {
      this.createOrMergeOrder(payload);
    } catch (err) {
      log.warn(`[OrderBoard] Could not enqueue order for ${payload?.itemCode || 'unknown'}: ${err?.message || String(err)}`);
    }
  }

  _deficitQty(requiredQty, itemCode, bank, ctx) {
    const required = Math.max(0, Math.floor(Number(requiredQty) || 0));
    if (required <= 0) return 0;
    const inInventory = ctx.itemCount(itemCode);
    const inBank = bank.get(itemCode) || 0;
    return Math.max(0, required - (inInventory + inBank));
  }

  /**
   * A plan is bank-only when all gather/bank inputs are already present in
   * current inventory + bank, so no gathering action is needed.
   */
  _isPlanBankOnly(plan, ctx, bank) {
    for (const step of plan) {
      if (step.type !== 'gather' && step.type !== 'bank' && step.type !== 'fight') continue;
      const have = ctx.itemCount(step.itemCode) + (bank.get(step.itemCode) || 0);
      if (have < step.quantity) return false;
    }
    return true;
  }

  /**
   * Record unmet bank-only deps that are obtainable via task exchange.
   * Called when a recipe is skipped due to missing bank ingredients.
   */
  _trackExchangeNeeds(bankSteps, bank) {
    for (const step of bankSteps) {
      if (!this.gameData.isTaskReward(step.itemCode)) continue;
      const inBank = bank.get(step.itemCode) || 0;
      const deficit = step.quantity - inBank;
      if (deficit > 0) {
        this._exchangeNeeds.set(step.itemCode,
          Math.max(this._exchangeNeeds.get(step.itemCode) || 0, deficit));
      }
    }
  }

  /** Merge manual taskCollection targets with dynamic crafting needs. */
  getExchangeTargets() {
    const targets = new Map();
    for (const [code, qty] of Object.entries(this.taskCollection)) {
      targets.set(code, qty);
    }
    for (const [code, qty] of this._exchangeNeeds) {
      targets.set(code, Math.max(targets.get(code) || 0, qty));
    }
    return targets;
  }

  /** Check if any exchange target is still unmet (bank + inventory < target). */
  hasUnmetExchangeTargets(bankItems, ctx) {
    for (const [code, target] of this.getExchangeTargets()) {
      const have = (bankItems.get(code) || 0) + ctx.itemCount(code);
      if (have < target) return true;
    }
    return false;
  }

  async _setupCombat(ctx) {
    const target = await this.findBestCombatTarget(ctx);
    if (!target) return false;

    this._monster = target.monster;
    this._monsterLoc = target.location;
    this._combatLoadout = target.loadout;
    log.info(`[${ctx.name}] Rotation: combat → ${target.monsterCode} (lv${target.monster.level})`);
    return true;
  }
}
