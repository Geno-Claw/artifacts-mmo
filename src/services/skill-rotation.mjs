/**
 * Skill rotation state manager.
 * Randomly cycles between skills (mining, woodcutting, fishing, cooking,
 * alchemy, combat, npc_task) with goal-based durations.
 */
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { findBestCombatTarget } from './gear-optimizer.mjs';

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
  npc_task: 1,
};

export class SkillRotation {
  constructor({ skills, goals = {}, weights, craftCollection = {}, craftBlacklist = {}, taskCollection = {} } = {}) {
    if (weights && Object.keys(weights).length > 0) {
      this.weights = weights;
      this.skills = Object.keys(weights).filter(s => weights[s] > 0);
    } else {
      this.skills = skills?.length > 0 ? skills : Object.keys(DEFAULT_GOALS);
      this.weights = null;
    }
    this.goals = { ...DEFAULT_GOALS, ...goals };
    this.craftCollection = craftCollection;       // { skill: bool }
    this.craftBlacklist = craftBlacklist;          // { skill: string[] }
    this.taskCollection = taskCollection;          // { itemCode: targetQty } manual targets
    this._exchangeNeeds = new Map();              // { itemCode → qty } dynamic targets from crafting

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
    this._isCollection = false; // true when crafting a missing collection item
  }

  isGoalComplete() {
    return this.currentSkill !== null && this.goalProgress >= this.goalTarget;
  }

  recordProgress(n = 1) {
    this.goalProgress += n;
  }

  /** Pick the next random skill and set up its state. */
  async pickNext(ctx) {
    this._resetState();
    this._exchangeNeeds.clear(); // rebuild dynamic targets from crafting setup

    const shuffled = this._weightedShuffle(this.skills);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this._isCollection ? 1 : (this.goals[skill] || DEFAULT_GOALS[skill] || 50);
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
    this._resetState();

    const others = this.skills.filter(s => s !== prev);
    const shuffled = this._weightedShuffle(others);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this._isCollection ? 1 : (this.goals[skill] || DEFAULT_GOALS[skill] || 50);
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
  get isCollection() { return this._isCollection; }

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
    this._isCollection = false;
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

  async _setupSkill(skill, ctx) {
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
    return false;
  }

  async _setupGathering(skill, ctx) {
    const level = ctx.skillLevel(skill);
    const resources = gameData.findResourcesBySkill(skill, level);
    if (resources.length === 0) return false;

    // Pick the highest-level resource
    this._resource = resources[0];
    this._resourceLoc = await gameData.getResourceLocation(this._resource.code);
    if (!this._resourceLoc) return false;

    log.info(`[${ctx.name}] Rotation: ${skill} → ${this._resource.code} (lv${this._resource.level})`);
    return true;
  }

  async _setupCrafting(skill, ctx) {
    const level = ctx.skillLevel(skill);

    // Tier 1: Collection — craft 1 of each missing item
    if (this.craftCollection[skill]) {
      const result = await this._setupCollectionCraft(skill, level, ctx);
      if (result) return true;
    }

    // Tier 2: XP grinding
    return this._setupXpGrind(skill, level, ctx);
  }

  /**
   * Tier 1: Find a craftable item missing from bank and set up crafting it.
   * Picks highest craft.level first for maximum XP while filling the collection.
   * Skips blacklisted items and items with unfulfillable bank-only dependencies.
   */
  async _setupCollectionCraft(skill, level, ctx) {
    const recipes = gameData.findItems({ craftSkill: skill, maxLevel: level });
    if (recipes.length === 0) return false;

    const bank = await gameData.getBankItems();
    const blacklist = new Set(this.craftBlacklist[skill] || []);

    // Items missing from bank, sorted by craft level DESC
    const missing = recipes
      .filter(item => {
        if (blacklist.has(item.code)) return false;
        return (bank.get(item.code) || 0) === 0;
      })
      .sort((a, b) => b.craft.level - a.craft.level);

    for (const item of missing) {
      const plan = gameData.resolveRecipeChain(item.craft);
      if (!plan || plan.length === 0) continue;
      if (!gameData.canFulfillPlan(plan, ctx)) continue;

      // Skip if any bank-only dependency can't be met
      const bankSteps = plan.filter(s => s.type === 'bank');
      if (bankSteps.length > 0) {
        const allMet = bankSteps.every(s => (bank.get(s.itemCode) || 0) >= s.quantity);
        if (!allMet) {
          // Track unmet deps that are task exchange rewards
          this._trackExchangeNeeds(bankSteps, bank);
          continue;
        }
      }

      this._recipe = item;
      this._isCollection = true;
      this._productionPlan = plan;
      this._planStepProgress = new Map();
      this._bankChecked = false;

      log.info(`[${ctx.name}] Rotation: ${skill} → COLLECT ${item.code} (lv${item.craft.level}, ${plan.length} steps)`);
      return true;
    }

    return false;
  }

  /**
   * Tier 2: Pick the best recipe for XP grinding.
   * Sorts by craft.level DESC (XP proxy), with bank availability as tiebreaker.
   * Skips blacklisted items and recipes with unmet bank-only dependencies.
   */
  async _setupXpGrind(skill, level, ctx) {
    const recipes = gameData.findItems({ craftSkill: skill, maxLevel: level });
    if (recipes.length === 0) return false;

    const bank = await gameData.getBankItems();
    const blacklist = new Set(this.craftBlacklist[skill] || []);

    const scored = [];
    for (const recipe of recipes) {
      if (blacklist.has(recipe.code)) continue;

      const plan = gameData.resolveRecipeChain(recipe.craft);
      if (!plan || plan.length === 0) continue;
      if (!gameData.canFulfillPlan(plan, ctx)) continue;

      // Skip recipes with unmet bank-only dependencies
      const bankSteps = plan.filter(s => s.type === 'bank');
      if (bankSteps.length > 0) {
        const allMet = bankSteps.every(s => (bank.get(s.itemCode) || 0) >= s.quantity);
        if (!allMet) {
          this._trackExchangeNeeds(bankSteps, bank);
          continue;
        }
      }

      const availability = this._scoreRecipeAvailability(plan, ctx, bank);
      scored.push({ recipe, plan, availability });
    }
    if (scored.length === 0) return false;

    // Primary: craft.level DESC (XP proxy), tiebreaker: availability DESC
    scored.sort((a, b) =>
      b.recipe.craft.level - a.recipe.craft.level ||
      b.availability - a.availability
    );

    const best = scored[0];
    this._recipe = best.recipe;
    this._isCollection = false;
    this._productionPlan = best.plan;
    this._planStepProgress = new Map();
    this._bankChecked = false;

    log.info(`[${ctx.name}] Rotation: ${skill} → XP ${this._recipe.code} (lv${this._recipe.craft.level}, ${best.plan.length} steps, avail: ${(best.availability * 100).toFixed(0)}%)`);
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
   * Record unmet bank-only deps that are obtainable via task exchange.
   * Called when a recipe is skipped due to missing bank ingredients.
   */
  _trackExchangeNeeds(bankSteps, bank) {
    for (const step of bankSteps) {
      if (!gameData.isTaskReward(step.itemCode)) continue;
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
    const target = await findBestCombatTarget(ctx);
    if (!target) return false;

    this._monster = target.monster;
    this._monsterLoc = target.location;
    this._combatLoadout = target.loadout;
    log.info(`[${ctx.name}] Rotation: combat → ${target.monsterCode} (lv${target.monster.level})`);
    return true;
  }
}
