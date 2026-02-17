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

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, opts);
    const json = await res.json();

    if (res.ok) return json.data;

    const code = json.error?.code || res.status;
    const message = json.error?.message || `HTTP ${res.status}`;

    // Auto-retry on cooldown (code 499)
    if (code === 499) {
      const match = message.match(/([\d.]+)\s*seconds?\s*remaining/);
      const wait = match ? parseFloat(match[1]) * 1000 + 500 : 3000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    const err = new Error(message);
    err.code = code;
    err.data = json.error?.data;
    throw err;
  }

  throw new Error(`Still in cooldown after 5 retries: ${method} ${path}`);
}

// --- Character endpoints ---

export async function getCharacter(name = CHARACTER) {
  return request('GET', `/characters/${name}`);
}

export async function getMyCharacters() {
  return request('GET', '/my/characters');
}

export async function createCharacter(name, skin = 'men1') {
  return request('POST', '/characters/create', { name, skin });
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

export async function useItem(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/use`, { code, quantity });
}

export async function craft(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/crafting`, { code, quantity });
}

export async function depositBank(items, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/deposit/item`, items);
}

export async function withdrawBank(items, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/withdraw/item`, items);
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

export async function cancelTask(name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/cancel`);
}

export async function taskExchange(name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/exchange`);
}

export async function getTaskRewards(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/tasks/rewards${qs ? '?' + qs : ''}`);
}

export async function buyGE(id, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/buy`, { id, quantity });
}

export async function sellGE(code, quantity, price, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/sell`, { code, quantity, price });
}

export async function cancelGE(id, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/cancel`, { id });
}

// --- Gold banking ---

export async function depositGold(quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/deposit/gold`, { quantity });
}

export async function withdrawGold(quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/withdraw/gold`, { quantity });
}

// --- Grand Exchange data ---

export async function getMyGEOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/my/grandexchange/orders${qs ? '?' + qs : ''}`);
}

export async function getMyGEHistory(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/my/grandexchange/history${qs ? '?' + qs : ''}`);
}

export async function getAllGEOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/grandexchange/orders${qs ? '?' + qs : ''}`);
}

// --- Bank data ---

export async function getBankItems(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/my/bank/items${qs ? '?' + qs : ''}`);
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
