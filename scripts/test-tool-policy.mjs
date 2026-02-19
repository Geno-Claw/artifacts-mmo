#!/usr/bin/env node
import assert from 'node:assert/strict';

process.env.ARTIFACTS_TOKEN ||= 'test-token';

const toolPolicy = await import('../src/services/tool-policy.mjs');

const {
  _resetForTests,
  _setDepsForTests,
  computeLatestToolBySkill,
  computeToolNeedsByCode,
  computeToolTargetsByCode,
  ensureMissingGatherToolOrder,
  getBestToolForSkillAtLevel,
  resolveItemOrderSource,
} = toolPolicy;

function makeTool(code, skill, level) {
  return {
    code,
    type: 'weapon',
    subtype: 'tool',
    level,
    effects: [{ name: skill, value: 1 }],
  };
}

function installGameDataDeps({ tools = [], items = new Map(), resources = new Map(), monsters = new Map() } = {}) {
  const toolList = [...tools];
  const itemMap = new Map(items);

  for (const tool of toolList) {
    itemMap.set(tool.code, tool);
  }

  _setDepsForTests({
    gameDataSvc: {
      findItems({ type, subtype, maxLevel } = {}) {
        return toolList.filter((item) => {
          if (type && item.type !== type) return false;
          if (subtype && item.subtype !== subtype) return false;
          if (maxLevel !== undefined && item.level > maxLevel) return false;
          return true;
        });
      },
      getItem(code) {
        return itemMap.get(code) || null;
      },
      getResourceForDrop(code) {
        return resources.get(code) || null;
      },
      getMonsterForDrop(code) {
        return monsters.get(code) || null;
      },
    },
  });
}

async function testToolNeedsAndTargetsRespectMixedLevels() {
  _resetForTests();

  const tools = [
    makeTool('stone_pick', 'mining', 1),
    makeTool('iron_pick', 'mining', 10),
    makeTool('steel_pick', 'mining', 20),
    makeTool('mythic_pick', 'mining', 50),
    makeTool('wood_axe', 'woodcutting', 1),
    makeTool('iron_axe', 'woodcutting', 15),
    makeTool('basic_rod', 'fishing', 1),
    makeTool('pro_rod', 'fishing', 12),
    makeTool('apprentice_mortar', 'alchemy', 5),
    makeTool('master_mortar', 'alchemy', 20),
  ];
  installGameDataDeps({ tools });

  const levels = {
    Low: 5,
    Mid: 12,
    High: 25,
  };

  const bestMidMining = getBestToolForSkillAtLevel('mining', 12);
  assert.equal(bestMidMining?.code, 'iron_pick', 'should pick highest equippable tool for level');

  const needs = computeToolNeedsByCode(levels);
  assert.equal(needs.get('stone_pick'), 1);
  assert.equal(needs.get('iron_pick'), 1);
  assert.equal(needs.get('steel_pick'), 1);
  assert.equal(needs.get('wood_axe'), 2);
  assert.equal(needs.get('iron_axe'), 1);
  assert.equal(needs.get('basic_rod'), 1);
  assert.equal(needs.get('pro_rod'), 2);
  assert.equal(needs.get('apprentice_mortar'), 2);
  assert.equal(needs.get('master_mortar'), 1);

  const latestBySkill = computeLatestToolBySkill(levels);
  assert.equal(latestBySkill.get('mining')?.code, 'steel_pick');
  assert.equal(latestBySkill.get('woodcutting')?.code, 'iron_axe');
  assert.equal(latestBySkill.get('fishing')?.code, 'pro_rod');
  assert.equal(latestBySkill.get('alchemy')?.code, 'master_mortar');

  const targets = computeToolTargetsByCode(levels);
  assert.equal(targets.get('steel_pick'), 5, 'latest mining tier should keep at least five');
  assert.equal(targets.get('iron_axe'), 5, 'latest woodcutting tier should keep at least five');
  assert.equal(targets.get('pro_rod'), 5, 'latest fishing tier should keep at least five');
  assert.equal(targets.get('master_mortar'), 5, 'latest alchemy tier should keep at least five');
  assert.equal(targets.get('stone_pick'), 1, 'lower tier still kept when needed by low-level chars');
}

async function testResolveItemOrderSourcePriority() {
  _resetForTests();

  const items = new Map([
    ['crafted_tool', { code: 'crafted_tool', craft: { skill: 'weaponcrafting', level: 11 }, level: 11 }],
    ['gathered_tool', { code: 'gathered_tool', level: 5 }],
    ['dropped_tool', { code: 'dropped_tool', level: 8 }],
  ]);
  const resources = new Map([
    ['gathered_tool', { code: 'ash_tree', skill: 'woodcutting', level: 3 }],
  ]);
  const monsters = new Map([
    ['dropped_tool', { monster: { code: 'wolf', level: 9 } }],
  ]);

  installGameDataDeps({ tools: [], items, resources, monsters });

  const craft = resolveItemOrderSource('crafted_tool');
  assert.equal(craft?.sourceType, 'craft');
  assert.equal(craft?.sourceCode, 'crafted_tool');
  assert.equal(craft?.craftSkill, 'weaponcrafting');

  const gather = resolveItemOrderSource('gathered_tool');
  assert.equal(gather?.sourceType, 'gather');
  assert.equal(gather?.sourceCode, 'ash_tree');
  assert.equal(gather?.gatherSkill, 'woodcutting');

  const fight = resolveItemOrderSource('dropped_tool');
  assert.equal(fight?.sourceType, 'fight');
  assert.equal(fight?.sourceCode, 'wolf');

  const missing = resolveItemOrderSource('unknown_tool');
  assert.equal(missing, null);
}

async function testEnsureMissingGatherToolOrderAvoidsDuplicateOverOrdering() {
  _resetForTests();

  const tools = [
    makeTool('stone_pick', 'mining', 1),
    makeTool('iron_pick', 'mining', 10),
  ];
  const resources = new Map([
    ['iron_pick', { code: 'iron_rocks', skill: 'mining', level: 10 }],
  ]);
  installGameDataDeps({ tools, resources });

  const contributionKey = 'tool_reserve::tool_reserve:mining:iron_pick';
  const boardOrder = {
    mergeKey: 'gather:iron_rocks:iron_pick',
    status: 'open',
    remainingQty: 2,
    contributions: {
      [contributionKey]: 2,
    },
  };

  const createdOrders = [];

  _setDepsForTests({
    getCharacterLevelsSnapshotFn: () => ({
      Low: 5,
      Mid: 12,
    }),
    globalCountFn: () => 1,
    getOrderBoardSnapshotFn: () => ({
      orders: [boardOrder],
    }),
    createOrMergeOrderFn: (payload) => {
      createdOrders.push(payload);
      const existing = Number(boardOrder.contributions[contributionKey]) || 0;
      if (payload.quantity > existing) {
        const delta = payload.quantity - existing;
        boardOrder.contributions[contributionKey] = payload.quantity;
        boardOrder.remainingQty += delta;
      }
      return { id: 'order-1' };
    },
  });

  const ctx = {
    name: 'Mid',
    get() {
      return { level: 12 };
    },
  };

  const first = ensureMissingGatherToolOrder(ctx, 'mining');
  assert.equal(first.queued, true, 'missing tool should queue a reserve order');
  assert.equal(first.toolCode, 'iron_pick');
  assert.equal(first.targetQty, 5);
  assert.equal(first.ownedQty, 1);
  assert.equal(first.pendingQty, 2);
  assert.equal(first.deficitQty, 2);
  assert.equal(createdOrders.length, 1, 'first call should create/update one order contribution');
  assert.equal(createdOrders[0].quantity, 4, 'order contribution should increase only by deficit amount');

  const second = ensureMissingGatherToolOrder(ctx, 'mining');
  assert.equal(second.queued, false, 'second call should not over-order when deficit is already covered');
  assert.equal(second.reason, 'deficit_satisfied');
  assert.equal(createdOrders.length, 1, 'no additional order call expected on repeat without state change');
}

async function run() {
  await testToolNeedsAndTargetsRespectMixedLevels();
  await testResolveItemOrderSourcePriority();
  await testEnsureMissingGatherToolOrderAvoidsDuplicateOverOrdering();
  _resetForTests();
  console.log('test-tool-policy: PASS');
}

run().catch((err) => {
  _resetForTests();
  console.error(err);
  process.exit(1);
});

