#!/usr/bin/env node
/**
 * Artifacts MMO HTML Report Generator
 * Fetches all character data + map tiles, generates a static HTML dashboard,
 * and stores snapshots for historical comparison.
 * 
 * Run via crontab every 5 minutes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Load .env
const envPath = '/home/claw/artifacts-mmo/.env';
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const TOKEN = process.env.ARTIFACTS_TOKEN;
const API = process.env.ARTIFACTS_API || 'https://api.artifactsmmo.com';
const REPORT_DIR = '/home/claw/artifacts-mmo/report';
const HISTORY_DIR = join(REPORT_DIR, 'history');
const MAP_CACHE = join(REPORT_DIR, 'map-cache.json');

mkdirSync(HISTORY_DIR, { recursive: true });

const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()).data;
}

async function getAllPages(path) {
  let items = [], page = 1;
  while (true) {
    const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}page=${page}&size=100`, { headers });
    const json = await res.json();
    if (!json.data || json.data.length === 0) break;
    items.push(...json.data);
    if (json.data.length < 100) break;
    page++;
  }
  return items;
}

// Load or fetch map data (cache for 24h to avoid hammering API)
async function getMapData() {
  if (existsSync(MAP_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(MAP_CACHE, 'utf-8'));
      if (Date.now() - cached.fetchedAt < 86400000) return cached.tiles;
    } catch {}
  }
  // Fetch all map pages (public endpoint, no auth needed)
  const allTiles = await getAllPages('/maps');
  const tiles = {};
  for (const m of allTiles) {
    if (m.layer !== 'overworld') continue;
    const k = `${m.x},${m.y}`;
    if (!tiles[k]) tiles[k] = { name: m.name, x: m.x, y: m.y };
    if (m.interactions?.content) tiles[k].content = m.interactions.content;
  }
  writeFileSync(MAP_CACHE, JSON.stringify({ fetchedAt: Date.now(), tiles }, null, 2));
  return tiles;
}

// Get git info
import { execSync } from 'child_process';
let gitRef = 'unknown', gitMsg = '';
try {
  gitRef = execSync('git rev-parse --short HEAD', { cwd: '/home/claw/artifacts-mmo' }).toString().trim();
  gitMsg = execSync('git log -1 --format=%s', { cwd: '/home/claw/artifacts-mmo' }).toString().trim();
} catch {}

const [chars, server, bank, bankItems, mapTiles] = await Promise.all([
  get('/my/characters'),
  get('/'),
  get('/my/bank'),
  getAllPages('/my/bank/items'),
  getMapData(),
]);

const now = new Date();
const nowStr = now.toISOString();
const todayKey = nowStr.slice(0, 10);

// Build snapshot
const snapshot = {
  timestamp: nowStr,
  characters: chars.map(c => ({
    name: c.name,
    level: c.level,
    xp: c.xp,
    max_xp: c.max_xp,
    total_xp: c.total_xp || 0,
    hp: c.hp,
    max_hp: c.max_hp,
    gold: c.gold,
    x: c.x, y: c.y,
    skills: {
      mining: { level: c.mining_level, xp: c.mining_xp, max_xp: c.mining_max_xp },
      woodcutting: { level: c.woodcutting_level, xp: c.woodcutting_xp, max_xp: c.woodcutting_max_xp },
      fishing: { level: c.fishing_level, xp: c.fishing_xp, max_xp: c.fishing_max_xp },
      cooking: { level: c.cooking_level, xp: c.cooking_xp, max_xp: c.cooking_max_xp },
      alchemy: { level: c.alchemy_level, xp: c.alchemy_xp, max_xp: c.alchemy_max_xp },
      weaponcrafting: { level: c.weaponcrafting_level, xp: c.weaponcrafting_xp, max_xp: c.weaponcrafting_max_xp },
      gearcrafting: { level: c.gearcrafting_level, xp: c.gearcrafting_xp, max_xp: c.gearcrafting_max_xp },
      jewelrycrafting: { level: c.jewelrycrafting_level, xp: c.jewelrycrafting_xp, max_xp: c.jewelrycrafting_max_xp },
    },
    weapon: c.weapon_slot || 'none',
    task: c.task || null,
    task_type: c.task_type || null,
    task_progress: c.task_progress || 0,
    task_total: c.task_total || 0,
    inventory_used: c.inventory ? c.inventory.filter(s => s.code).length : 0,
    inventory_max: c.inventory_max_items || 20,
  })),
  bank: {
    gold: bank?.gold || 0,
    items: bankItems.map(i => ({ code: i.code, quantity: i.quantity })),
  },
  server: { version: server.version, season: server.season?.name, online: server.characters_online },
};

// Save snapshots
writeFileSync(join(HISTORY_DIR, `${todayKey}.json`), JSON.stringify(snapshot, null, 2));
writeFileSync(join(HISTORY_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));

// Load yesterday for comparison
const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
let yesterdaySnap = null;
const yesterdayFile = join(HISTORY_DIR, `${yesterday}.json`);
if (existsSync(yesterdayFile)) {
  try { yesterdaySnap = JSON.parse(readFileSync(yesterdayFile, 'utf-8')); } catch {}
}

// Clean old history (30 days)
try {
  const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10) + '.json';
  for (const f of readdirSync(HISTORY_DIR).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/) && f < cutoff)) {
    unlinkSync(join(HISTORY_DIR, f));
  }
} catch {}

// Helpers
function delta(current, previous) {
  if (previous == null) return '';
  const diff = current - previous;
  if (diff > 0) return `<span class="delta up">+${diff}</span>`;
  if (diff < 0) return `<span class="delta down">${diff}</span>`;
  return '';
}

function getYesterdayChar(name) {
  return yesterdaySnap?.characters?.find(c => c.name === name) || null;
}

function fmt(s) { return s.replace(/_/g, ' '); }

function tileInfo(x, y) {
  const tile = mapTiles[`${x},${y}`];
  if (!tile) return { label: `Unknown (${x},${y})`, icon: '❓' };
  
  const name = tile.name || 'Unknown';
  const content = tile.content;
  
  if (!content) return { label: name, icon: '🗺️' };
  
  const typeIcons = {
    monster: '⚔️', resource: '⛏️', workshop: '🔨',
    bank: '🏦', grand_exchange: '📈', tasks_master: '📋',
    npc: '🧑', portal: '🌀',
  };
  const icon = typeIcons[content.type] || '📍';
  const code = fmt(content.code);
  return { label: `${name} — ${code}`, icon, type: content.type, code: content.code };
}

function contentColor(type) {
  return {
    monster: '#f85149', resource: '#3fb950', workshop: '#d29922',
    bank: '#8b949e', grand_exchange: '#58a6ff', tasks_master: '#bc8cff',
  }[type] || '#8b949e';
}

// Generate HTML
const totalGold = snapshot.bank.gold + snapshot.characters.reduce((s, c) => s + c.gold, 0);
const totalLevels = snapshot.characters.reduce((s, c) => s + c.level, 0);
const totalSkillLevels = snapshot.characters.reduce((s, c) =>
  s + Object.values(c.skills).reduce((ss, sk) => ss + sk.level, 0), 0);
const yTotalGold = yesterdaySnap ? yesterdaySnap.bank.gold + yesterdaySnap.characters.reduce((s, c) => s + c.gold, 0) : null;
const yTotalLevels = yesterdaySnap ? yesterdaySnap.characters.reduce((s, c) => s + c.level, 0) : null;
const yTotalSkillLevels = yesterdaySnap ? yesterdaySnap.characters.reduce((s, c) => s + Object.values(c.skills).reduce((ss, sk) => ss + sk.level, 0), 0) : null;

const bankTop = snapshot.bank.items.sort((a, b) => b.quantity - a.quantity).slice(0, 20);

const charCards = snapshot.characters.map(c => {
  const yc = getYesterdayChar(c.name);
  const xpPct = c.max_xp > 0 ? ((c.xp / c.max_xp) * 100).toFixed(1) : 0;
  const skills = Object.entries(c.skills).filter(([, v]) => v.level > 0).sort((a, b) => b[1].level - a[1].level);
  const tile = tileInfo(c.x, c.y);
  const tileColor = contentColor(tile.type);

  // NPC task
  let taskHtml = '';
  if (c.task) {
    const taskPct = c.task_total > 0 ? ((c.task_progress / c.task_total) * 100).toFixed(0) : 0;
    const taskTypeIcon = c.task_type === 'monsters' ? '⚔️' : c.task_type === 'items' ? '📦' : '📋';
    taskHtml = `
    <div class="task-section">
      <div class="task-header">${taskTypeIcon} Task: <strong>${fmt(c.task)}</strong> <span class="dim">(${c.task_type})</span></div>
      <div style="display:flex;justify-content:space-between;font-size:0.8em;color:var(--dim);margin-bottom:2px">
        <span>${c.task_progress} / ${c.task_total}</span><span>${taskPct}%</span>
      </div>
      <div class="xp-bar"><div class="xp-fill" style="width:${taskPct}%;background:var(--purple)"></div></div>
    </div>`;
  }

  return `<div class="card">
  <div class="card-header">
    <h2>${c.name} <span class="lvl">Lv${c.level} ${delta(c.level, yc?.level)}</span></h2>
    <div class="location-badge" style="background:${tileColor}20;color:${tileColor};border:1px solid ${tileColor}40">
      ${tile.icon} ${tile.label}
    </div>
  </div>
  <div class="xp-section">
    <div style="display:flex;justify-content:space-between;font-size:0.8em;color:var(--dim);margin-bottom:2px">
      <span>XP ${c.xp.toLocaleString()} / ${c.max_xp.toLocaleString()}</span><span>${xpPct}%</span>
    </div>
    <div class="xp-bar"><div class="xp-fill" style="width:${xpPct}%"></div></div>
  </div>
  <div class="char-stats">
    <span>❤️ ${c.hp}/${c.max_hp}</span>
    <span>💰 ${c.gold}</span>
    <span>🎒 ${c.inventory_used}/${c.inventory_max}</span>
    <span>⚔️ ${fmt(c.weapon || 'none')}</span>
  </div>
  ${taskHtml}
  ${skills.length > 0 ? `<table><tr><th>Skill</th><th>Level</th><th>XP</th><th></th></tr>
  ${skills.map(([name, sk]) => {
    const pct = sk.max_xp > 0 ? ((sk.xp / sk.max_xp) * 100).toFixed(0) : 0;
    const ySkill = yc?.skills?.[name];
    return `<tr><td>${name}</td><td>${sk.level} ${delta(sk.level, ySkill?.level)}</td><td>${sk.xp}/${sk.max_xp}</td><td><div class="xp-bar" style="width:60px"><div class="xp-fill" style="width:${pct}%"></div></div></td></tr>`;
  }).join('')}
  </table>` : '<div style="color:var(--dim);font-size:0.85em">No skills trained</div>'}
</div>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts MMO — Geno-Claw Dashboard</title>
<meta http-equiv="refresh" content="300">
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --dim: #8b949e; --green: #3fb950; --red: #f85149; --gold: #d29922; --blue: #58a6ff; --purple: #bc8cff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px; padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 1.5em; margin-bottom: 4px; }
  .subtitle { color: var(--dim); margin-bottom: 20px; font-size: 0.85em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
  .card h2 { font-size: 1.1em; margin: 0; display: flex; align-items: center; gap: 8px; }
  .card h2 .lvl { color: var(--blue); font-size: 0.85em; }
  .location-badge { font-size: 0.8em; padding: 3px 10px; border-radius: 12px; font-weight: 500; white-space: nowrap; }
  .summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { text-align: center; }
  .stat .val { font-size: 1.8em; font-weight: 600; }
  .stat .label { font-size: 0.75em; color: var(--dim); text-transform: uppercase; }
  .xp-section { margin-bottom: 8px; }
  .xp-bar { width: 100%; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .xp-fill { height: 100%; background: var(--green); border-radius: 3px; }
  .char-stats { display: flex; gap: 12px; font-size: 0.85em; margin-bottom: 10px; flex-wrap: wrap; }
  .task-section { background: var(--bg); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
  .task-header { font-size: 0.85em; margin-bottom: 6px; }
  .dim { color: var(--dim); }
  .delta { font-size: 0.8em; font-weight: 600; margin-left: 4px; }
  .delta.up { color: var(--green); }
  .delta.down { color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .bank-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px; font-size: 0.85em; }
  .bank-item { display: flex; justify-content: space-between; padding: 4px 8px; background: var(--bg); border-radius: 4px; }
  .bank-item .qty { color: var(--gold); font-weight: 600; }
  footer { color: var(--dim); font-size: 0.75em; margin-top: 24px; text-align: center; }
</style>
</head>
<body>
<h1>🦖 Artifacts MMO — Geno-Claw</h1>
<div class="subtitle">Season ${snapshot.server.season || '?'} · v${snapshot.server.version || '?'} · ${snapshot.server.online || '?'} online · Updated ${now.toUTCString()} · Bot <a href="https://github.com/Geno-Claw/artifacts-mmo/commit/${gitRef}" style="color:var(--blue);text-decoration:none" title="${gitMsg.replace(/"/g, '&quot;')}">${gitRef}</a></div>

<div class="summary">
  <div class="stat"><div class="val" style="color:var(--gold)">${totalGold.toLocaleString()} ${delta(totalGold, yTotalGold)}</div><div class="label">Total Gold</div></div>
  <div class="stat"><div class="val">${totalLevels} ${delta(totalLevels, yTotalLevels)}</div><div class="label">Combined Levels</div></div>
  <div class="stat"><div class="val">${totalSkillLevels} ${delta(totalSkillLevels, yTotalSkillLevels)}</div><div class="label">Total Skill Levels</div></div>
  <div class="stat"><div class="val">${snapshot.bank.items.length}</div><div class="label">Bank Items</div></div>
</div>

<div class="grid">
${charCards}
</div>

<div class="card" style="max-width:800px">
  <h2 style="margin-bottom:12px">🏦 Bank (Top 20)</h2>
  <div class="bank-grid">
    ${bankTop.map(i => `<div class="bank-item"><span>${fmt(i.code)}</span><span class="qty">×${i.quantity}</span></div>`).join('\n    ')}
  </div>
</div>

<footer>Auto-refreshes every 5 minutes · Geno-Claw Dashboard</footer>
</body>
</html>`;

writeFileSync(join(REPORT_DIR, 'index.html'), html);
console.log(`Report generated at ${nowStr}`);
