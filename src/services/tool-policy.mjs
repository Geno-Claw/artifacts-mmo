import * as log from '../log.mjs';
import * as gameData from './game-data.mjs';
import { createOrMergeOrder, getOrderBoardSnapshot } from './order-board.mjs';
import { globalCount, getCharacterLevelsSnapshot } from './inventory-manager.mjs';

const TOOL_SKILLS = Object.freeze(['mining', 'woodcutting', 'fishing', 'alchemy']);
const TOOL_EFFECT_BY_SKILL = Object.freeze({
  mining: 'mining',
  woodcutting: 'woodcutting',
  fishing: 'fishing',
  alchemy: 'alchemy',
});
const LATEST_TOOL_BANK_RESERVE = 5;

function createDefaultDeps() {
  return {
    gameDataSvc: gameData,
    createOrMergeOrderFn: createOrMergeOrder,
    getOrderBoardSnapshotFn: getOrderBoardSnapshot,
    globalCountFn: globalCount,
    getCharacterLevelsSnapshotFn: getCharacterLevelsSnapshot,
  };
}

let _deps = createDefaultDeps();

function toPositiveInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function isToolForSkill(item, skill) {
  if (!item || item.type !== 'weapon' || item.subtype !== 'tool') return false;
  const effectName = TOOL_EFFECT_BY_SKILL[skill];
  if (!effectName || !Array.isArray(item.effects)) return false;
  return item.effects.some(e => (e?.name || e?.code) === effectName);
}

function toLevelsMap(levelsByChar = {}) {
  const out = new Map();
  if (levelsByChar instanceof Map) {
    for (const [name, rawLevel] of levelsByChar.entries()) {
      const charName = `${name || ''}`.trim();
      const level = toPositiveInt(rawLevel);
      if (!charName || level <= 0) continue;
      out.set(charName, level);
    }
    return out;
  }

  if (!levelsByChar || typeof levelsByChar !== 'object') return out;
  for (const [name, rawLevel] of Object.entries(levelsByChar)) {
    const charName = `${name || ''}`.trim();
    const level = toPositiveInt(rawLevel);
    if (!charName || level <= 0) continue;
    out.set(charName, level);
  }
  return out;
}

function mergeLevelsWithContext(levelsByChar, ctx, levelOverride = null) {
  const merged = toLevelsMap(levelsByChar);
  const ctxName = `${ctx?.name || ''}`.trim();
  if (!ctxName) return merged;
  const ctxLevel = toPositiveInt(levelOverride);
  if (ctxLevel > 0) merged.set(ctxName, ctxLevel);
  return merged;
}

function compareToolTier(a, b) {
  const levelA = toPositiveInt(a?.level);
  const levelB = toPositiveInt(b?.level);
  if (levelA !== levelB) return levelB - levelA;
  const codeA = `${a?.code || ''}`;
  const codeB = `${b?.code || ''}`;
  return codeA.localeCompare(codeB);
}

function contributionKeyFor(requesterName, recipeCode) {
  return `${requesterName}::${recipeCode}`;
}

function mergeKeyFor(sourceType, sourceCode, itemCode) {
  return `${sourceType}:${sourceCode}:${itemCode}`;
}

function findOpenOrder(snapshot, sourceType, sourceCode, itemCode) {
  const expected = mergeKeyFor(sourceType, sourceCode, itemCode);
  const orders = Array.isArray(snapshot?.orders) ? snapshot.orders : [];

  for (const order of orders) {
    if (order?.status === 'fulfilled') continue;
    if (order?.mergeKey === expected) return order;
  }

  // Backstop in case mergeKey is absent in fixture data.
  for (const order of orders) {
    if (order?.status === 'fulfilled') continue;
    if (order?.sourceType !== sourceType) continue;
    if (order?.sourceCode !== sourceCode) continue;
    if (order?.itemCode !== itemCode) continue;
    return order;
  }

  return null;
}

export function getBestToolForSkillAtLevel(skill, level) {
  if (!TOOL_SKILLS.includes(skill)) return null;
  const maxLevel = toPositiveInt(level);
  if (maxLevel <= 0) return null;

  const allTools = _deps.gameDataSvc.findItems({ type: 'weapon', subtype: 'tool', maxLevel }) || [];
  const matching = allTools.filter(item => isToolForSkill(item, skill));
  if (matching.length === 0) return null;

  matching.sort(compareToolTier);
  return matching[0] || null;
}

export function computeToolNeedsByCode(levelsByChar) {
  const levels = toLevelsMap(levelsByChar);
  const needs = new Map();

  for (const [, level] of levels.entries()) {
    for (const skill of TOOL_SKILLS) {
      const tool = getBestToolForSkillAtLevel(skill, level);
      if (!tool?.code) continue;
      needs.set(tool.code, (needs.get(tool.code) || 0) + 1);
    }
  }

  return needs;
}

export function computeLatestToolBySkill(levelsByChar) {
  const levels = toLevelsMap(levelsByChar);
  const latestBySkill = new Map();

  for (const [, level] of levels.entries()) {
    for (const skill of TOOL_SKILLS) {
      const tool = getBestToolForSkillAtLevel(skill, level);
      if (!tool?.code) continue;

      const current = latestBySkill.get(skill);
      if (!current || compareToolTier(tool, current) < 0) {
        latestBySkill.set(skill, tool);
      }
    }
  }

  return latestBySkill;
}

export function computeToolTargetsByCode(levelsByChar) {
  const needsByCode = computeToolNeedsByCode(levelsByChar);
  const latestBySkill = computeLatestToolBySkill(levelsByChar);
  const targets = new Map(needsByCode);

  for (const tool of latestBySkill.values()) {
    if (!tool?.code) continue;
    const current = targets.get(tool.code) || 0;
    targets.set(tool.code, Math.max(LATEST_TOOL_BANK_RESERVE, current));
  }

  return targets;
}

export function resolveItemOrderSource(itemCode) {
  const code = `${itemCode || ''}`.trim();
  if (!code) return null;

  const item = _deps.gameDataSvc.getItem(code);
  if (item?.craft?.skill) {
    return {
      sourceType: 'craft',
      sourceCode: code,
      gatherSkill: null,
      craftSkill: item.craft.skill,
      sourceLevel: toPositiveInt(item.craft.level || item.level),
    };
  }

  const resource = _deps.gameDataSvc.getResourceForDrop(code);
  if (resource?.code) {
    return {
      sourceType: 'gather',
      sourceCode: resource.code,
      gatherSkill: resource.skill || null,
      craftSkill: null,
      sourceLevel: toPositiveInt(resource.level),
    };
  }

  const monsterDrop = _deps.gameDataSvc.getMonsterForDrop(code);
  if (monsterDrop?.monster?.code) {
    return {
      sourceType: 'fight',
      sourceCode: monsterDrop.monster.code,
      gatherSkill: null,
      craftSkill: null,
      sourceLevel: toPositiveInt(monsterDrop.monster.level),
    };
  }

  return null;
}

export function ensureMissingGatherToolOrder(ctx, skill) {
  if (!ctx?.name || !TOOL_SKILLS.includes(skill)) {
    return { queued: false, reason: 'invalid_input' };
  }

  let charLevel = 0;
  try {
    charLevel = toPositiveInt(ctx.get()?.level);
  } catch {
    charLevel = 0;
  }
  if (charLevel <= 0) {
    return { queued: false, reason: 'missing_character_level' };
  }

  const tool = getBestToolForSkillAtLevel(skill, charLevel);
  if (!tool?.code) {
    return { queued: false, reason: 'no_equippable_tool_defined' };
  }

  const source = resolveItemOrderSource(tool.code);
  if (!source) {
    log.warn(`[${ctx.name}] Missing tool ${tool.code} for ${skill} but no acquisition source could be resolved`);
    return { queued: false, reason: 'missing_order_source', toolCode: tool.code };
  }

  const snapshotLevels = _deps.getCharacterLevelsSnapshotFn();
  const levelsByChar = mergeLevelsWithContext(snapshotLevels, ctx, charLevel);
  const targetsByCode = computeToolTargetsByCode(levelsByChar);
  const targetQty = targetsByCode.get(tool.code) || 0;
  if (targetQty <= 0) {
    return { queued: false, reason: 'no_target_qty', toolCode: tool.code };
  }

  const orderSnapshot = _deps.getOrderBoardSnapshotFn();
  const existingOrder = findOpenOrder(orderSnapshot, source.sourceType, source.sourceCode, tool.code);
  const pendingQty = Math.max(0, toPositiveInt(existingOrder?.remainingQty));
  const ownedQty = Math.max(0, toPositiveInt(_deps.globalCountFn(tool.code)));
  const deficitQty = targetQty - (ownedQty + pendingQty);

  if (deficitQty <= 0) {
    return {
      queued: false,
      reason: 'deficit_satisfied',
      toolCode: tool.code,
      targetQty,
      ownedQty,
      pendingQty,
      deficitQty: 0,
    };
  }

  const requesterName = 'tool_reserve';
  const recipeCode = `tool_reserve:${skill}:${tool.code}`;
  const contributionKey = contributionKeyFor(requesterName, recipeCode);
  const currentContribution = Math.max(0, toPositiveInt(existingOrder?.contributions?.[contributionKey]));
  const requestedQty = currentContribution + deficitQty;

  const created = _deps.createOrMergeOrderFn({
    requesterName,
    recipeCode,
    itemCode: tool.code,
    sourceType: source.sourceType,
    sourceCode: source.sourceCode,
    gatherSkill: source.gatherSkill,
    craftSkill: source.craftSkill,
    sourceLevel: source.sourceLevel,
    quantity: requestedQty,
  });

  const queued = Boolean(created);
  if (queued) {
    log.info(
      `[${ctx.name}] Tool reserve order: ${tool.code} target ${targetQty} ` +
      `(owned ${ownedQty}, pending ${pendingQty}, +${deficitQty})`,
    );
  }

  return {
    queued,
    reason: queued ? 'queued' : 'order_create_failed',
    toolCode: tool.code,
    targetQty,
    ownedQty,
    pendingQty,
    deficitQty,
    requestedQty,
    sourceType: source.sourceType,
    sourceCode: source.sourceCode,
  };
}

export function _setDepsForTests(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  _deps = {
    ..._deps,
    ...input,
  };
}

export function _resetForTests() {
  _deps = createDefaultDeps();
}

