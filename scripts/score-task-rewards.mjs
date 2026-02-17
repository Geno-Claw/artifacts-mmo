#!/usr/bin/env node
/**
 * Score task exchange rewards by what equipment they enable crafting.
 * Traces each reward item → crafting recipes that use it → resulting equipment → gear score.
 *
 * Usage: node scripts/score-task-rewards.mjs
 */
import 'dotenv/config';

const API = process.env.ARTIFACTS_API || 'https://api.artifactsmmo.com';
const TOKEN = process.env.ARTIFACTS_TOKEN;
if (!TOKEN) { console.error('ARTIFACTS_TOKEN not set in .env'); process.exit(1); }

import { getWeight } from '../src/data/scoring-weights.mjs';

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.data;
}

async function loadAll(endpoint) {
  const results = [];
  let page = 1;
  while (true) {
    const batch = await apiGet(`/${endpoint}?page=${page}&size=100`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results;
}

function scoreItem(item) {
  if (!item.effects) return 0;
  let score = 0;
  for (const e of item.effects) {
    score += (e.value || 0) * getWeight(e.name || e.code);
  }
  return score;
}

const EQUIPMENT_TYPES = new Set([
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring', 'amulet',
]);

async function main() {
  console.error('Loading data from API...');
  const [allItems, rewards] = await Promise.all([
    loadAll('items'),
    loadAll('tasks/rewards'),
  ]);
  console.error(`Loaded ${allItems.length} items, ${rewards.length} task rewards`);

  const itemMap = new Map(allItems.map(i => [i.code, i]));
  const rewardCodes = new Set(rewards.map(r => r.code));

  // Build reverse index: ingredient code → items that use it in crafting
  const usedIn = new Map(); // itemCode → [{ item, qtyNeeded }]
  for (const item of allItems) {
    if (!item.craft?.items) continue;
    for (const mat of item.craft.items) {
      if (!usedIn.has(mat.code)) usedIn.set(mat.code, []);
      usedIn.get(mat.code).push({ item, qtyNeeded: mat.quantity });
    }
  }

  // For each reward, find what equipment it enables (direct or transitive)
  const rewardScores = [];

  for (const reward of rewards) {
    const rewardItem = itemMap.get(reward.code);
    const craftsInto = [];

    // Direct: recipes using this reward as ingredient
    const directUses = usedIn.get(reward.code) || [];

    // Walk up the crafting tree to find final equipment
    const visited = new Set();
    const queue = [...directUses.map(u => ({ item: u.item, qtyNeeded: u.qtyNeeded, chain: [u.item.code] }))];

    while (queue.length > 0) {
      const { item, qtyNeeded, chain } = queue.shift();
      if (visited.has(item.code)) continue;
      visited.add(item.code);

      if (EQUIPMENT_TYPES.has(item.type)) {
        craftsInto.push({
          code: item.code,
          name: item.name,
          type: item.type,
          level: item.level,
          gearScore: scoreItem(item),
          craftSkill: item.craft?.skill || '?',
          craftLevel: item.craft?.level || '?',
          qtyNeeded,
          chain,
        });
      }

      // Check if this intermediate is used in further recipes
      const furtherUses = usedIn.get(item.code) || [];
      for (const u of furtherUses) {
        if (!visited.has(u.item.code)) {
          queue.push({ item: u.item, qtyNeeded: u.qtyNeeded, chain: [...chain, u.item.code] });
        }
      }
    }

    // Sort equipment by gear score DESC
    craftsInto.sort((a, b) => b.gearScore - a.gearScore);

    const bestScore = craftsInto.length > 0 ? craftsInto[0].gearScore : 0;
    rewardScores.push({
      code: reward.code,
      rate: reward.rate,
      quantity: reward.quantity,
      description: rewardItem?.name || reward.code,
      bestScore,
      equipmentCount: craftsInto.length,
      craftsInto,
    });
  }

  // Sort rewards by best equipment score DESC
  rewardScores.sort((a, b) => b.bestScore - a.bestScore);

  // Output
  console.log('\n=== Task Exchange Rewards — Ranked by Equipment Value ===\n');
  console.log(`${'Reward'.padEnd(25)} ${'Rate'.padStart(5)} ${'Qty'.padStart(4)} ${'Best Score'.padStart(10)} ${'# Equip'.padStart(8)}`);
  console.log('-'.repeat(60));

  for (const r of rewardScores) {
    console.log(
      `${r.code.padEnd(25)} ${String(r.rate).padStart(5)} ${String(r.quantity).padStart(4)} ${r.bestScore.toFixed(1).padStart(10)} ${String(r.equipmentCount).padStart(8)}`
    );

    // Show top 3 equipment items this reward enables
    for (const eq of r.craftsInto.slice(0, 3)) {
      const chain = eq.chain.length > 1 ? ` (via ${eq.chain.slice(0, -1).join(' → ')})` : '';
      console.log(
        `  → ${eq.code} [${eq.type}] lv${eq.level} score=${eq.gearScore.toFixed(1)} (${eq.craftSkill} lv${eq.craftLevel}, needs ${eq.qtyNeeded}x)${chain}`
      );
    }
    if (r.craftsInto.length > 3) {
      console.log(`  ... and ${r.craftsInto.length - 3} more`);
    }
  }

  console.log(`\n${rewardScores.length} rewards analyzed`);
}

main().catch(err => { console.error(err); process.exit(1); });
