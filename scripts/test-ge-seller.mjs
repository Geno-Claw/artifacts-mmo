#!/usr/bin/env node
import assert from 'node:assert/strict';

const geSeller = await import('../src/services/ge-seller.mjs');
const surplus = await import('../src/services/equipment-surplus.mjs');

const {
  analyzeSellCandidates,
  _resetForTests: resetGeSellerForTests,
  _setSellRulesForTests,
} = geSeller;
const {
  _resetForTests: resetSurplusForTests,
  _setDepsForTests: setSurplusDepsForTests,
} = surplus;

function installSurplusDeps({
  itemsByCode,
  claimedByCode,
  openOrderByCode = new Map(),
  globalByCode,
  bankByCode,
  levelsByChar = {},
  trackedCharNames = Object.keys(levelsByChar || {}),
  needsByCode = new Map(),
  latestBySkill = new Map(),
  targetsByCode = new Map(),
}) {
  setSurplusDepsForTests({
    gameDataSvc: {
      getItem(code) {
        return itemsByCode.get(code) || null;
      },
      isEquipmentType(item) {
        return item?.type === 'weapon'
          || item?.type === 'shield'
          || item?.type === 'helmet'
          || item?.type === 'body_armor'
          || item?.type === 'leg_armor'
          || item?.type === 'boots'
          || item?.type === 'ring'
          || item?.type === 'amulet'
          || item?.type === 'artifact'
          || item?.type === 'bag'
          || item?.type === 'rune';
      },
    },
    getClaimedTotalFn: (code) => claimedByCode.get(code) || 0,
    getOpenOrderDemandByCodeFn: () => openOrderByCode,
    globalCountFn: (code) => globalByCode.get(code) || 0,
    bankCountFn: (code) => bankByCode.get(code) || 0,
    getCharacterToolProfilesSnapshotFn: () => levelsByChar,
    getCharacterLevelsSnapshotFn: () => levelsByChar,
    getTrackedCharacterNamesFn: () => trackedCharNames,
    computeToolNeedsByCodeFn: () => needsByCode,
    computeLatestToolBySkillFn: () => latestBySkill,
    computeToolTargetsByCodeFn: () => targetsByCode,
  });
}

function testAnalyzeSellCandidatesIncludesDuplicateDroppedGear() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['forest_ring', 3],
    ['wooden_club', 2],
    ['iron_ore', 12],
    ['tasks_coin', 9],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['forest_ring', { code: 'forest_ring', type: 'ring', level: 8 }],
      ['wooden_club', { code: 'wooden_club', type: 'weapon', level: 4 }],
      ['iron_ore', { code: 'iron_ore', type: 'resource', level: 1 }],
      ['tasks_coin', { code: 'tasks_coin', type: 'resource', level: 1 }],
    ]),
    claimedByCode: new Map([
      ['forest_ring', 1],
      ['wooden_club', 0],
    ]),
    globalByCode: new Map([
      ['forest_ring', 3],
      ['wooden_club', 2],
      ['iron_ore', 12],
      ['tasks_coin', 9],
    ]),
    bankByCode: bankItems,
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: true,
    alwaysSell: [{ code: 'iron_ore', keepInBank: 5 }],
    neverSell: ['tasks_coin'],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  rows.sort((a, b) => a.code.localeCompare(b.code));

  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [
      { code: 'forest_ring', quantity: 2 },
      { code: 'iron_ore', quantity: 7 },
      { code: 'wooden_club', quantity: 2 },
    ],
    'GE sell candidates should include duplicate dropped gear and explicit always-sell items',
  );
}

function testAnalyzeSellCandidatesRespectsToolReserveAndClaims() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['iron_pick', 9],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['iron_pick', { code: 'iron_pick', type: 'weapon', subtype: 'tool', level: 10 }],
    ]),
    claimedByCode: new Map([
      ['iron_pick', 2],
    ]),
    globalByCode: new Map([
      ['iron_pick', 9],
    ]),
    bankByCode: bankItems,
    levelsByChar: {
      MinerA: 20,
      MinerB: 20,
    },
    trackedCharNames: ['MinerA', 'MinerB'],
    needsByCode: new Map([
      ['iron_pick', 2],
    ]),
    latestBySkill: new Map([
      ['mining', { code: 'iron_pick', level: 10 }],
    ]),
    targetsByCode: new Map([
      ['iron_pick', 5],
    ]),
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: true,
    alwaysSell: [],
    neverSell: [],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [{ code: 'iron_pick', quantity: 4 }],
    'tool duplicates should still keep claimed copies and the bank reserve floor',
  );
}

function testAnalyzeSellCandidatesFallsBackToAlwaysSellWhenDuplicateSellingDisabled() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['forest_ring', 3],
    ['copper_ore', 9],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['forest_ring', { code: 'forest_ring', type: 'ring', level: 8 }],
      ['copper_ore', { code: 'copper_ore', type: 'resource', level: 1 }],
    ]),
    claimedByCode: new Map([
      ['forest_ring', 0],
    ]),
    globalByCode: new Map([
      ['forest_ring', 3],
      ['copper_ore', 9],
    ]),
    bankByCode: bankItems,
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: false,
    alwaysSell: [{ code: 'copper_ore', keepInBank: 2 }],
    neverSell: [],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [{ code: 'copper_ore', quantity: 7 }],
    'always-sell rules should still work independently of duplicate gear selling',
  );
}

function testAlwaysSellOverridesDuplicateKeepLogicForMatchingCode() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['forest_ring', 4],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['forest_ring', { code: 'forest_ring', type: 'ring', level: 8 }],
    ]),
    claimedByCode: new Map([
      ['forest_ring', 3],
    ]),
    openOrderByCode: new Map([
      ['forest_ring', 2],
    ]),
    globalByCode: new Map([
      ['forest_ring', 4],
    ]),
    bankByCode: bankItems,
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: true,
    alwaysSell: [{ code: 'forest_ring', keepInBank: 1 }],
    neverSell: [],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity, reason: row.reason })),
    [{ code: 'forest_ring', quantity: 3, reason: 'always-sell override (keeping 1)' }],
    'alwaysSell should override duplicate-gear keep logic for the same item code',
  );
}

function testAnalyzeSellCandidatesProtectsOpenOrderDemand() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['skeleton_pants', 2],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['skeleton_pants', { code: 'skeleton_pants', type: 'leg_armor', level: 20 }],
    ]),
    claimedByCode: new Map([
      ['skeleton_pants', 1],
    ]),
    openOrderByCode: new Map([
      ['skeleton_pants', 1],
    ]),
    globalByCode: new Map([
      ['skeleton_pants', 2],
    ]),
    bankByCode: bankItems,
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: true,
    alwaysSell: [],
    neverSell: [],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  assert.deepEqual(
    rows,
    [],
    'open order demand should reserve duplicate equipment before GE selling',
  );
}

function testAnalyzeSellCandidatesRespectsOpenToolDemand() {
  resetGeSellerForTests();
  resetSurplusForTests();

  const bankItems = new Map([
    ['iron_pick', 7],
  ]);

  installSurplusDeps({
    itemsByCode: new Map([
      ['iron_pick', { code: 'iron_pick', type: 'weapon', subtype: 'tool', level: 10 }],
    ]),
    claimedByCode: new Map([
      ['iron_pick', 0],
    ]),
    openOrderByCode: new Map([
      ['iron_pick', 3],
    ]),
    globalByCode: new Map([
      ['iron_pick', 7],
    ]),
    bankByCode: bankItems,
    levelsByChar: {
      MinerA: 20,
      MinerB: 20,
    },
    trackedCharNames: ['MinerA', 'MinerB'],
    needsByCode: new Map([
      ['iron_pick', 2],
    ]),
    latestBySkill: new Map(),
    targetsByCode: new Map([
      ['iron_pick', 2],
    ]),
  });

  _setSellRulesForTests({
    sellDuplicateEquipment: true,
    alwaysSell: [],
    neverSell: [],
  });

  const rows = analyzeSellCandidates({ name: 'Seller' }, bankItems);
  assert.deepEqual(
    rows.map(row => ({ code: row.code, quantity: row.quantity })),
    [{ code: 'iron_pick', quantity: 4 }],
    'open tool orders should reserve stock before duplicate tool GE selling',
  );
}

function run() {
  try {
    testAnalyzeSellCandidatesIncludesDuplicateDroppedGear();
    testAnalyzeSellCandidatesRespectsToolReserveAndClaims();
    testAnalyzeSellCandidatesFallsBackToAlwaysSellWhenDuplicateSellingDisabled();
    testAlwaysSellOverridesDuplicateKeepLogicForMatchingCode();
    testAnalyzeSellCandidatesProtectsOpenOrderDemand();
    testAnalyzeSellCandidatesRespectsOpenToolDemand();
    console.log('test-ge-seller: PASS');
  } finally {
    resetGeSellerForTests();
    resetSurplusForTests();
  }
}

run();
