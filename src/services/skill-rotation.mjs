/**
 * Skill rotation state manager.
 * Randomly cycles between skills (mining, woodcutting, fishing, cooking,
 * alchemy, combat, npc_task) with goal-based durations.
 */
import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { canBeatMonster } from './combat-simulator.mjs';

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
  constructor({ skills = [], goals = {} } = {}) {
    this.skills = skills.length > 0 ? skills : Object.keys(DEFAULT_GOALS);
    this.goals = { ...DEFAULT_GOALS, ...goals };

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
    this._bankChecked = false;  // whether bank withdrawal happened for current recipe
    this._upgradeTarget = null; // { itemCode, slot, recipe, scoreDelta } for gear upgrades
    this._isUpgrade = false;    // true when crafting an equipment upgrade
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

    // Shuffle skills and try each until one is viable
    const shuffled = [...this.skills].sort(() => Math.random() - 0.5);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this._isUpgrade ? 1 : (this.goals[skill] || DEFAULT_GOALS[skill] || 50);
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
    const shuffled = others.sort(() => Math.random() - 0.5);

    for (const skill of shuffled) {
      const ok = await this._setupSkill(skill, ctx);
      if (ok) {
        this.currentSkill = skill;
        this.goalTarget = this._isUpgrade ? 1 : (this.goals[skill] || DEFAULT_GOALS[skill] || 50);
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
  get bankChecked() { return this._bankChecked; }
  set bankChecked(v) { this._bankChecked = v; }
  get upgradeTarget() { return this._upgradeTarget; }
  get isUpgrade() { return this._isUpgrade; }

  // --- Internal ---

  _resetState() {
    this._resource = null;
    this._resourceLoc = null;
    this._recipe = null;
    this._productionPlan = null;
    this._planStepProgress = null;
    this._monster = null;
    this._monsterLoc = null;
    this._bankChecked = false;
    this._upgradeTarget = null;
    this._isUpgrade = false;
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
    // 1. Try to find an equipment upgrade for this craft skill
    const upgrade = gameData.findBestUpgrade(ctx, { craftSkill: skill });
    if (upgrade) {
      const plan = gameData.resolveRecipeChain(upgrade.recipe);
      if (plan && plan.length > 0) {
        this._upgradeTarget = upgrade;
        this._isUpgrade = true;
        this._recipe = gameData.getItem(upgrade.itemCode);
        this._productionPlan = plan;
        this._planStepProgress = new Map();
        this._bankChecked = false;
        log.info(`[${ctx.name}] Rotation: ${skill} → UPGRADE ${upgrade.itemCode} for ${upgrade.slot} (+${upgrade.scoreDelta.toFixed(1)} score, ${plan.length} steps)`);
        return true;
      }
    }

    // 2. Fallback: highest-level recipe for XP, scored by bank availability
    const level = ctx.skillLevel(skill);
    const recipes = gameData.findItems({ craftSkill: skill, maxLevel: level });
    if (recipes.length === 0) return false;

    const bank = await gameData.getBankItems();

    const scored = [];
    for (const recipe of recipes) {
      const plan = gameData.resolveRecipeChain(recipe.craft);
      if (!plan || plan.length === 0) continue;
      const score = this._scoreRecipeAvailability(plan, ctx, bank);
      scored.push({ recipe, plan, score });
    }
    if (scored.length === 0) return false;

    scored.sort((a, b) => b.score - a.score || b.recipe.level - a.recipe.level);

    const best = scored[0];
    this._recipe = best.recipe;
    this._isUpgrade = false;
    this._upgradeTarget = null;
    this._productionPlan = best.plan;
    this._planStepProgress = new Map();
    this._bankChecked = false;

    log.info(`[${ctx.name}] Rotation: ${skill} → ${this._recipe.code} (lv${this._recipe.level}, ${best.plan.length} steps, avail: ${(best.score * 100).toFixed(0)}%)`);
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

  async _setupCombat(ctx) {
    const level = ctx.get().level;
    const monsters = gameData.findMonstersByLevel(level);
    if (monsters.length === 0) return false;

    // Pick the highest-level monster we can reliably beat
    for (const m of monsters) {
      if (!canBeatMonster(ctx, m.code)) continue;
      const loc = await gameData.getMonsterLocation(m.code);
      if (!loc) continue;
      this._monster = m;
      this._monsterLoc = loc;
      log.info(`[${ctx.name}] Rotation: combat → ${m.code} (lv${m.level})`);
      return true;
    }

    log.info(`[${ctx.name}] Rotation: no beatable monster found`);
    return false;
  }
}
