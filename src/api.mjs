/**
 * Artifacts MMO API client
 */
import 'dotenv/config';

const API = process.env.ARTIFACTS_API || 'https://api.artifactsmmo.com';
const TOKEN = process.env.ARTIFACTS_TOKEN;
const CHARACTER = process.env.CHARACTER_NAME || 'GenoClaw';

if (!TOKEN) throw new Error('ARTIFACTS_TOKEN not set in .env');

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API}${path}`, opts);
  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.error?.message || `HTTP ${res.status}`);
    err.code = json.error?.code || res.status;
    err.data = json.error?.data;
    throw err;
  }
  return json.data;
}

// --- Character endpoints ---

export async function getCharacter(name = CHARACTER) {
  return request('GET', `/characters/${name}`);
}

export async function getMyCharacters() {
  return request('GET', '/my/characters');
}

export async function move(x, y, name = CHARACTER) {
  return request('POST', `/my/${name}/action/move`, { x, y });
}

export async function fight(name = CHARACTER) {
  return request('POST', `/my/${name}/action/fight`);
}

export async function gather(name = CHARACTER) {
  return request('POST', `/my/${name}/action/gathering`);
}

export async function rest(name = CHARACTER) {
  return request('POST', `/my/${name}/action/rest`);
}

export async function craft(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/crafting`, { code, quantity });
}

export async function depositBank(code, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/deposit`, { code, quantity });
}

export async function withdrawBank(code, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/withdraw`, { code, quantity });
}

export async function equipItem(slot, code, name = CHARACTER) {
  return request('POST', `/my/${name}/action/equip`, { slot, code });
}

export async function unequipItem(slot, name = CHARACTER) {
  return request('POST', `/my/${name}/action/unequip`, { slot });
}

export async function acceptTask(name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/new`);
}

export async function completeTask(name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/complete`);
}

export async function buyGE(code, quantity, price, name = CHARACTER) {
  return request('POST', `/my/${name}/action/ge/buy`, { code, quantity, price });
}

export async function sellGE(code, quantity, price, name = CHARACTER) {
  return request('POST', `/my/${name}/action/ge/sell`, { code, quantity, price });
}

// --- World data ---

export async function getMaps(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/maps${qs ? '?' + qs : ''}`);
}

export async function getMap(x, y) {
  return request('GET', `/maps/${x}/${y}`);
}

export async function getItems(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/items${qs ? '?' + qs : ''}`);
}

export async function getMonsters(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/monsters${qs ? '?' + qs : ''}`);
}

export async function getResources(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/resources${qs ? '?' + qs : ''}`);
}

export async function getServerStatus() {
  return request('GET', '/');
}

// --- Utility ---

export function waitForCooldown(actionResult) {
  const cd = actionResult?.cooldown?.remaining_seconds || actionResult?.cooldown?.total_seconds || 0;
  if (cd > 0) {
    return new Promise(resolve => setTimeout(resolve, cd * 1000 + 500));
  }
  return Promise.resolve();
}

export { API, TOKEN, CHARACTER };
