#!/usr/bin/env node
/**
 * Export all equipment items with their effects and gear scores to CSV.
 * Usage: node scripts/export-gear-scores.mjs > gear-scores.csv
 */
import 'dotenv/config';

const API = process.env.ARTIFACTS_API || 'https://api.artifactsmmo.com';
const TOKEN = process.env.ARTIFACTS_TOKEN;
if (!TOKEN) { console.error('ARTIFACTS_TOKEN not set in .env'); process.exit(1); }

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.data;
}

async function loadAllItems() {
  const items = [];
  let page = 1;
  while (true) {
    const batch = await apiGet(`/items?page=${page}&size=100`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return items;
}

import { getWeight } from '../src/data/scoring-weights.mjs';

function scoreItem(item) {
  if (!item.effects) return 0;
  let score = 0;
  for (const e of item.effects) {
    const name = e.name || e.code;
    score += (e.value || 0) * getWeight(name);
  }
  return score;
}

const EQUIPMENT_TYPES = new Set([
  'weapon', 'shield', 'helmet', 'body_armor',
  'leg_armor', 'boots', 'ring', 'amulet', 'bag',
]);

// Collect all unique effect names across all equipment
function collectEffectNames(items) {
  const names = new Set();
  for (const item of items) {
    if (!item.effects) continue;
    for (const e of item.effects) {
      names.add(e.name || e.code);
    }
  }
  // Sort for consistent column order
  return [...names].sort((a, b) => {
    // Order: attack > dmg > res > haste > hp > other
    const order = (n) => {
      if (n.startsWith('attack_')) return 0;
      if (n === 'dmg' || n.startsWith('dmg_')) return 1;
      if (n.startsWith('res_')) return 2;
      if (n === 'haste') return 3;
      if (n === 'hp') return 4;
      return 5;
    };
    return order(a) - order(b) || a.localeCompare(b);
  });
}

function escapeCsv(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  console.error('Loading items from API...');
  const allItems = await loadAllItems();
  console.error(`Loaded ${allItems.length} total items`);

  const equipment = allItems.filter(i => EQUIPMENT_TYPES.has(i.type));
  console.error(`${equipment.length} equipment items`);

  const effectNames = collectEffectNames(equipment);

  // CSV header
  const header = [
    'code', 'name', 'type', 'level', 'gear_score',
    ...effectNames.map(n => `${n} (val)`),
    ...effectNames.map(n => `${n} (wt)`),
    ...effectNames.map(n => `${n} (contrib)`),
    'craft_skill', 'craft_level',
  ];
  console.log(header.map(escapeCsv).join(','));

  // Sort: by type, then by level, then by score descending
  equipment.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    if (a.level !== b.level) return a.level - b.level;
    return scoreItem(b) - scoreItem(a);
  });

  for (const item of equipment) {
    const effectMap = {};
    for (const e of item.effects || []) {
      effectMap[e.name || e.code] = e.value || 0;
    }

    const score = scoreItem(item);

    const row = [
      item.code,
      item.name,
      item.type,
      item.level,
      score.toFixed(1),
      // Raw values
      ...effectNames.map(n => effectMap[n] !== undefined ? effectMap[n] : ''),
      // Weights
      ...effectNames.map(n => effectMap[n] !== undefined ? getWeight(n) : ''),
      // Weighted contributions
      ...effectNames.map(n => effectMap[n] !== undefined ? (effectMap[n] * getWeight(n)).toFixed(1) : ''),
      item.craft?.skill || '',
      item.craft?.level || '',
    ];
    console.log(row.map(escapeCsv).join(','));
  }

  console.error(`Wrote ${equipment.length} rows`);
}

main().catch(err => { console.error(err); process.exit(1); });
