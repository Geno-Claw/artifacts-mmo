/**
 * Artifacts MMO API client
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import * as log from './log.mjs';
import { describeActionResult } from './action-log.mjs';

const API = process.env.ARTIFACTS_API || 'https://api.artifactsmmo.com';
const TOKEN = process.env.ARTIFACTS_TOKEN;
const CHARACTER = process.env.CHARACTER_NAME || 'GenoClaw';
const actionObservers = new Set();
const apiLog = log.createLogger({ scope: 'api' });

if (!TOKEN) throw new Error('ARTIFACTS_TOKEN not set in .env');

function emitActionEvent(evt) {
  for (const observer of actionObservers) {
    try {
      observer(evt);
    } catch {
      // Action observers must not affect API request flow.
    }
  }
}

function extractActionInfo(method, path) {
  if (method !== 'POST') return null;
  const match = path.match(/^\/my\/([^/]+)\/action\/(.+)$/);
  if (!match) return null;
  return {
    name: match[1],
    action: match[2],
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonSafely(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bodySnippet(raw, maxLen = 180) {
  const compact = `${raw || ''}`.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3)}...`;
}

function isRetryableGatewayStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

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

  const requestId = randomUUID();
  const actionInfo = extractActionInfo(method, path);

  function actionEvent(status, extra = {}) {
    if (!actionInfo) return;
    emitActionEvent({
      name: actionInfo.name,
      action: actionInfo.action,
      method,
      path,
      requestId,
      status,
      observedAt: Date.now(),
      ...extra,
    });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const attemptNo = attempt + 1;
    const attemptStartedAt = Date.now();
    apiLog.debug(`${method} ${path} attempt ${attemptNo}`, {
      event: 'api.request.start',
      context: {
        requestId,
        action: actionInfo?.action || null,
      },
      data: {
        method,
        path,
        attempt: attemptNo,
      },
    });

    let res;
    try {
      res = await fetch(`${API}${path}`, opts);
    } catch (err) {
      const durationMs = Date.now() - attemptStartedAt;
      if (attempt < 4) {
        actionEvent('retry', {
          attempt: attemptNo,
          durationMs,
          reasonCode: 'network_retry',
          message: err?.message || String(err),
        });
        apiLog.warn(`Network error for ${method} ${path}, retrying`, {
          event: 'api.request.retry',
          reasonCode: 'network_retry',
          context: {
            requestId,
            action: actionInfo?.action || null,
          },
          data: {
            method,
            path,
            attempt: attemptNo,
            durationMs,
          },
          error: err,
        });
        await sleep((attempt + 1) * 1000);
        continue;
      }
      const networkErr = new Error(`Network error for ${method} ${path}: ${err?.message || String(err)}`);
      networkErr.code = 'network_error';
      actionEvent('failed', {
        attempt: attemptNo,
        durationMs,
        reasonCode: 'request_failed',
        message: networkErr.message,
      });
      apiLog.error(`Network error for ${method} ${path}`, {
        event: 'api.request.fail',
        reasonCode: 'request_failed',
        context: {
          requestId,
          action: actionInfo?.action || null,
        },
        data: {
          method,
          path,
          attempt: attemptNo,
          durationMs,
        },
        error: networkErr,
      });
      throw networkErr;
    }

    const raw = await res.text();
    const json = parseJsonSafely(raw);
    const durationMs = Date.now() - attemptStartedAt;

    if (res.ok) {
      if (!json || typeof json !== 'object' || !('data' in json)) {
        const invalidBody = bodySnippet(raw);
        const err = new Error(
          invalidBody
            ? `Unexpected API response format (HTTP ${res.status}): ${invalidBody}`
            : `Unexpected API response format (HTTP ${res.status})`,
        );
        err.code = res.status;
        actionEvent('failed', {
          attempt: attemptNo,
          durationMs,
          reasonCode: 'request_failed',
          message: err.message,
          code: err.code,
        });
        apiLog.error(`Unexpected API response for ${method} ${path}`, {
          event: 'api.request.fail',
          reasonCode: 'request_failed',
          context: {
            requestId,
            action: actionInfo?.action || null,
          },
          data: {
            method,
            path,
            attempt: attemptNo,
            durationMs,
            status: res.status,
          },
          error: err,
        });
        throw err;
      }

      if (json.data && typeof json.data === 'object') {
        try {
          Object.defineProperty(json.data, '__requestMeta', {
            value: {
              requestId,
              method,
              path,
              attempt: attemptNo,
              durationMs,
              action: actionInfo?.action || null,
              name: actionInfo?.name || null,
            },
            enumerable: false,
            configurable: true,
          });
        } catch {
          // Non-fatal metadata assignment failure.
        }
      }

      const cooldown = json.data?.cooldown || null;
      const actionResult = actionInfo
        ? describeActionResult(actionInfo.action, json.data, {
          characterName: actionInfo.name,
          requestBody: body,
        })
        : null;
      actionEvent('success', {
        attempt: attemptNo,
        durationMs,
        cooldown,
        result: actionResult,
      });
      if (actionInfo && actionResult) {
        apiLog.info(`Action ${actionInfo.action} completed`, {
          event: 'api.action.result',
          context: {
            requestId,
            action: actionInfo.action,
          },
          detail: actionResult.summary,
          data: {
            method,
            path,
            attempt: attemptNo,
            durationMs,
            status: res.status,
            type: actionResult.type,
            detail: actionResult.detail,
            cooldownSeconds: cooldown?.total_seconds ?? cooldown?.remaining_seconds ?? 0,
          },
        });
      }
      apiLog.debug(`${method} ${path} success`, {
        event: 'api.request.success',
        context: {
          requestId,
          action: actionInfo?.action || null,
        },
        data: {
          method,
          path,
          attempt: attemptNo,
          durationMs,
          status: res.status,
        },
      });
      return json.data;
    }

    const code = Number(json?.error?.code) || res.status;
    const fallbackBody = bodySnippet(raw);
    const message = json?.error?.message
      || (fallbackBody ? `HTTP ${res.status}: ${fallbackBody}` : `HTTP ${res.status}`);

    // Auto-retry on cooldown (code 499)
    if (code === 499) {
      if (isShuttingDown()) {
        const err = new Error(message);
        err.code = code;
        actionEvent('failed', {
          attempt: attemptNo,
          durationMs,
          reasonCode: 'request_failed',
          code,
          message,
        });
        apiLog.warn(`${method} ${path} failed during shutdown`, {
          event: 'api.request.fail',
          reasonCode: 'request_failed',
          context: {
            requestId,
            action: actionInfo?.action || null,
          },
          data: {
            method,
            path,
            attempt: attemptNo,
            durationMs,
            code,
            status: res.status,
          },
          error: err,
        });
        throw err;
      }
      const match = message.match(/([\d.]+)\s*seconds?\s*remaining/);
      const wait = match ? parseFloat(match[1]) * 1000 + 500 : 3000;
      actionEvent('retry', {
        attempt: attemptNo,
        durationMs,
        reasonCode: 'cooldown_499_retry',
        code,
        message,
        waitMs: wait,
      });
      apiLog.debug(`${method} ${path} cooldown retry`, {
        event: 'api.request.retry',
        reasonCode: 'cooldown_499_retry',
        context: {
          requestId,
          action: actionInfo?.action || null,
        },
        data: {
          method,
          path,
          attempt: attemptNo,
          durationMs,
          waitMs: wait,
          code,
          status: res.status,
        },
      });
      await sleep(wait);
      continue;
    }

    // Transient upstream/gateway errors often return non-JSON bodies.
    if (isRetryableGatewayStatus(res.status) && attempt < 4) {
      actionEvent('retry', {
        attempt: attemptNo,
        durationMs,
        reasonCode: 'gateway_retry',
        code,
        message,
      });
      apiLog.warn(`${method} ${path} gateway retry`, {
        event: 'api.request.retry',
        reasonCode: 'gateway_retry',
        context: {
          requestId,
          action: actionInfo?.action || null,
        },
        data: {
          method,
          path,
          attempt: attemptNo,
          durationMs,
          code,
          status: res.status,
        },
      });
      await sleep((attempt + 1) * 1000);
      continue;
    }

    const err = new Error(message);
    err.code = code;
    err.data = json?.error?.data;
    err.status = res.status;
    actionEvent('failed', {
      attempt: attemptNo,
      durationMs,
      reasonCode: 'request_failed',
      code,
      message,
    });
    apiLog.error(`${method} ${path} failed`, {
      event: 'api.request.fail',
      reasonCode: 'request_failed',
      context: {
        requestId,
        action: actionInfo?.action || null,
      },
      data: {
        method,
        path,
        attempt: attemptNo,
        durationMs,
        code,
        status: res.status,
      },
      error: err,
    });
    throw err;
  }

  const finalErr = new Error(`Request failed after 5 attempts: ${method} ${path}`);
  actionEvent('failed', {
    attempt: 5,
    durationMs: 0,
    reasonCode: 'request_failed',
    message: finalErr.message,
  });
  apiLog.error(`Request failed after 5 attempts: ${method} ${path}`, {
    event: 'api.request.fail',
    reasonCode: 'request_failed',
    context: {
      requestId,
      action: actionInfo?.action || null,
    },
    error: finalErr,
  });
  throw finalErr;
}

// --- Character endpoints ---

export async function getCharacter(name = CHARACTER) {
  return request('GET', `/characters/${name}`);
}

export async function getMyCharacters() {
  return request('GET', '/my/characters');
}

export async function getMyDetails() {
  return request('GET', '/my/details');
}

export async function createCharacter(name, skin = 'men1') {
  return request('POST', '/characters/create', { name, skin });
}

export async function move(x, y, name = CHARACTER) {
  return request('POST', `/my/${name}/action/move`, { x, y });
}

export async function transition(name = CHARACTER) {
  return request('POST', `/my/${name}/action/transition`);
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

export async function recycle(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/recycling`, { code, quantity });
}

export async function depositBank(items, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/deposit/item`, items);
}

export async function withdrawBank(items, name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/withdraw/item`, items);
}

export async function equipItem(slot, code, name = CHARACTER, quantity = 1) {
  return request('POST', `/my/${name}/action/equip`, { slot, code, quantity });
}

export async function unequipItem(slot, name = CHARACTER, quantity = 1) {
  return request('POST', `/my/${name}/action/unequip`, { slot, quantity });
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

export async function taskTrade(code, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/trade`, { code, quantity });
}

export async function taskExchange(name = CHARACTER) {
  return request('POST', `/my/${name}/action/task/exchange`);
}

// --- NPC transactions ---

export async function npcBuy(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/npc/buy`, { code, quantity });
}

export async function npcSell(code, quantity = 1, name = CHARACTER) {
  return request('POST', `/my/${name}/action/npc/sell`, { code, quantity });
}

export async function getTaskRewards(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/tasks/rewards${qs ? '?' + qs : ''}`);
}

export async function buyGE(id, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/buy`, { id, quantity });
}

export async function sellGE(code, quantity, price, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/create-sell-order`, { code, quantity, price });
}

export async function cancelGE(id, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/cancel`, { id });
}

export async function createBuyOrderGE(code, quantity, price, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/create-buy-order`, { code, quantity, price });
}

export async function fillBuyOrderGE(id, quantity, name = CHARACTER) {
  return request('POST', `/my/${name}/action/grandexchange/fill`, { id, quantity });
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

// --- Pending items ---

export async function getPendingItems(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/my/pending-items${qs ? '?' + qs : ''}`);
}

export async function claimPendingItem(id, name = CHARACTER) {
  return request('POST', `/my/${name}/action/claim_item/${id}`);
}

export async function getAccountAchievements(account, params = {}) {
  const safeAccount = encodeURIComponent(`${account || ''}`.trim());
  if (!safeAccount) {
    throw new Error('getAccountAchievements(account) requires a non-empty account');
  }
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/accounts/${safeAccount}/achievements${qs ? '?' + qs : ''}`);
}

export async function getAchievements(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/achievements${qs ? '?' + qs : ''}`);
}

// --- Bank data ---

export async function getBankItems(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/my/bank/items${qs ? '?' + qs : ''}`);
}

export async function getBankDetails() {
  return request('GET', '/my/bank');
}

export async function buyBankExpansion(name = CHARACTER) {
  return request('POST', `/my/${name}/action/bank/buy_expansion`);
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

// --- NPC data ---

export async function getNpcItems(npcCode, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/npcs/items/${npcCode}${qs ? '?' + qs : ''}`);
}

// --- Events ---

export async function getEvents(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/events${qs ? '?' + qs : ''}`);
}

export async function getActiveEvents(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/events/active${qs ? '?' + qs : ''}`);
}

// --- Sandbox (sandbox server only) ---

export function isSandbox() {
  return API.includes('sandbox');
}

export async function sandboxGiveGold(character, quantity) {
  return request('POST', '/sandbox/give_gold', { character, quantity });
}

export async function sandboxGiveItem(character, code, quantity) {
  return request('POST', '/sandbox/give_item', { character, code, quantity });
}

export async function sandboxGiveXp(character, type, amount) {
  return request('POST', '/sandbox/give_xp', { character, type, amount });
}

export async function sandboxSpawnEvent(code) {
  return request('POST', '/sandbox/spawn_event', { code });
}

export async function sandboxResetAccount() {
  return request('POST', '/sandbox/reset_account', {});
}

// --- Simulation ---

export async function simulateFight(body) {
  return request('POST', '/simulation/fight_simulation', body);
}

// --- Utility ---

let _cooldownAbort = new AbortController();

export function waitForCooldown(actionResult) {
  const cd = actionResult?.cooldown?.remaining_seconds || actionResult?.cooldown?.total_seconds || 0;
  const reqMeta = actionResult?.__requestMeta || null;
  const requestId = reqMeta?.requestId || null;
  const action = reqMeta?.action || null;

  if (cd <= 0) {
    apiLog.debug('Cooldown wait skipped', {
      scope: 'cooldown',
      event: 'cooldown.wait.skipped',
      context: {
        requestId,
        action,
      },
    });
    return Promise.resolve();
  }

  const signal = _cooldownAbort.signal;
  if (signal.aborted) {
    apiLog.debug('Cooldown wait skipped due to shutdown abort signal', {
      scope: 'cooldown',
      event: 'cooldown.wait.aborted',
      context: {
        requestId,
        action,
      },
      reasonCode: 'loop_stop_requested',
      data: {
        seconds: cd,
      },
    });
    return Promise.resolve();
  }

  const startedAt = Date.now();
  const waitMs = cd * 1000 + 500;
  apiLog.debug(`Cooldown wait start (${cd}s)`, {
    scope: 'cooldown',
    event: 'cooldown.wait.start',
    context: {
      requestId,
      action,
    },
    data: {
      seconds: cd,
      waitMs,
    },
  });

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      apiLog.debug('Cooldown wait complete', {
        scope: 'cooldown',
        event: 'cooldown.wait.end',
        context: {
          requestId,
          action,
        },
        data: {
          seconds: cd,
          waitMs,
          actualMs: Date.now() - startedAt,
        },
      });
      resolve();
    }, waitMs);

    function onAbort() {
      clearTimeout(timer);
      apiLog.debug('Cooldown wait aborted', {
        scope: 'cooldown',
        event: 'cooldown.wait.aborted',
        context: {
          requestId,
          action,
        },
        reasonCode: 'loop_stop_requested',
        data: {
          seconds: cd,
          waitMs,
          actualMs: Date.now() - startedAt,
        },
      });
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Abort all pending cooldown waits immediately. Called on shutdown. */
export function abortAllCooldowns() {
  _cooldownAbort.abort();
}

/** True when shutdown is in progress and loops should exit early. */
export function isShuttingDown() {
  return _cooldownAbort.signal.aborted;
}

/** Reset the abort controller for a fresh run. Called on startup/restart. */
export function resetCooldownAbort() {
  _cooldownAbort = new AbortController();
}

export function subscribeActionEvents(listener) {
  if (typeof listener !== 'function') {
    throw new Error('subscribeActionEvents(listener) requires a function');
  }
  actionObservers.add(listener);
  return () => actionObservers.delete(listener);
}

export { API, TOKEN, CHARACTER };
