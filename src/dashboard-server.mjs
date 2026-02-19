import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import * as log from './log.mjs';
import { getCachedAccountAchievements, getCachedAccountDetails } from './services/account-cache.mjs';
import {
  ConfigStoreError,
  loadConfigSnapshot,
  saveConfigAtomically,
  validateBotConfig,
} from './services/config-store.mjs';
import { getUiCharacterDetail, getUiSnapshot, subscribeUiEvents } from './services/ui-state.mjs';

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function toPort(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error, detail, code = error, extra = null) {
  const payload = { error };
  if (detail) payload.detail = detail;
  if (code) payload.code = code;
  if (extra && typeof extra === 'object') {
    Object.assign(payload, extra);
  }
  sendJson(res, status, payload);
}

function firstText(...values) {
  for (const value of values) {
    const text = `${value ?? ''}`.trim();
    if (text) return text;
  }
  return '';
}

function toFiniteIntOrNull(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.floor(num);
}

function statusFromError(err, fallback = 502) {
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const numCode = Number(err?.code);
  if (Number.isInteger(numCode) && numCode >= 400 && numCode <= 599) return numCode;
  if (err?.code === 'account_required') return 400;
  return fallback;
}

function sendStructuredError(res, err, fallbackCode) {
  if (res.headersSent) return;
  const status = statusFromError(err);
  const detail = err?.message || 'Upstream request failed';
  const code = err?.code != null ? `${err.code}` : fallbackCode;
  sendError(res, status, 'upstream_error', detail, code);
}

function sendConfigError(res, err, fallbackCode = 'config_error') {
  if (res.headersSent) return;
  if (err instanceof ConfigStoreError) {
    const extra = {};
    if (Array.isArray(err.errors)) extra.errors = err.errors;
    sendError(
      res,
      err.status || 500,
      err.error || 'config_error',
      err.detail || err.message || 'Config operation failed',
      err.code || fallbackCode,
      extra,
    );
    return;
  }
  sendError(res, 500, 'config_error', err?.message || 'Config operation failed', fallbackCode);
}

function sendRuntimeControlError(res, err, fallbackCode = 'runtime_control_failed') {
  if (res.headersSent) return;

  const status = statusFromError(err, 500);
  const detail = err?.detail || err?.message || 'Runtime control operation failed';
  const code = err?.code != null ? `${err.code}` : fallbackCode;
  const error = err?.error ? `${err.error}` : (status === 409 ? 'operation_conflict' : 'runtime_error');

  const extra = {};
  if (err?.currentOperation) extra.currentOperation = err.currentOperation;
  if (err?.requestedOperation) extra.requestedOperation = err.requestedOperation;
  if (err?.statusSnapshot && typeof err.statusSnapshot === 'object') {
    extra.status = err.statusSnapshot;
  }

  sendError(res, status, error, detail, code, Object.keys(extra).length > 0 ? extra : null);
}

const MAX_JSON_BODY_BYTES = 1_000_000;

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
    totalSize += buf.length;
    if (totalSize > MAX_JSON_BODY_BYTES) {
      throw new ConfigStoreError('Request body too large', {
        status: 413,
        error: 'bad_request',
        code: 'payload_too_large',
        detail: `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
      });
    }
    chunks.push(buf);
  }

  const bodyText = Buffer.concat(chunks).toString('utf-8').trim();
  if (!bodyText) {
    throw new ConfigStoreError('Request body is required', {
      status: 400,
      error: 'bad_json',
      code: 'bad_json',
      detail: 'Request body must be valid JSON',
    });
  }

  try {
    return JSON.parse(bodyText);
  } catch (err) {
    throw new ConfigStoreError('Invalid JSON body', {
      status: 400,
      error: 'bad_json',
      code: 'bad_json',
      detail: err?.message || 'Failed to parse JSON body',
    });
  }
}

function parseAchievementQuery(searchParams) {
  const params = {};
  const page = firstText(searchParams.get('page'));
  const size = firstText(searchParams.get('size'));
  if (page) params.page = page;
  if (size) params.size = size;
  return params;
}

function normalizeAchievementPage(payload) {
  if (Array.isArray(payload)) {
    return {
      list: payload,
      meta: {
        page: 1,
        size: payload.length,
        total: payload.length,
        pages: 1,
      },
    };
  }

  const safe = payload && typeof payload === 'object' ? payload : {};
  const list = Array.isArray(safe.data) ? safe.data : [];
  return {
    list,
    meta: {
      page: toFiniteIntOrNull(safe.page),
      size: toFiniteIntOrNull(safe.size),
      total: toFiniteIntOrNull(safe.total),
      pages: toFiniteIntOrNull(safe.pages),
    },
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function classifyAchievement(item) {
  const safe = item && typeof item === 'object' ? item : null;
  if (!safe) return 'unknown';

  const status = firstText(safe.status, safe.state, safe.progress_state).toLowerCase();
  if (status === 'completed' || status === 'complete' || status === 'done' || status === 'finished') {
    return 'completed';
  }
  if (status === 'in-progress' || status === 'in_progress' || status === 'active') {
    return 'inProgress';
  }
  if (status === 'not_started' || status === 'not-started' || status === 'new') {
    return 'notStarted';
  }

  if (typeof safe.completed === 'boolean') {
    return safe.completed ? 'completed' : 'notStarted';
  }
  if (typeof safe.is_completed === 'boolean') {
    return safe.is_completed ? 'completed' : 'notStarted';
  }
  if (typeof safe.isCompleted === 'boolean') {
    return safe.isCompleted ? 'completed' : 'notStarted';
  }

  const completedAt = firstText(
    safe.completed_at,
    safe.completedAt,
    safe.finished_at,
    safe.finishedAt,
    safe.unlocked_at,
    safe.unlockedAt,
  );
  if (completedAt) return 'completed';

  const current = firstFiniteNumber(
    safe.current,
    safe.current_progress,
    safe.currentProgress,
    safe.progress,
    safe.value,
    safe.points,
  );
  const target = firstFiniteNumber(
    safe.total,
    safe.target,
    safe.goal,
    safe.required,
    safe.max,
    safe.objective,
  );

  if (current != null && target != null && target > 0) {
    if (current >= target) return 'completed';
    if (current > 0) return 'inProgress';
    return 'notStarted';
  }
  if (current != null) {
    if (current <= 0) return 'notStarted';
    return 'inProgress';
  }

  return 'unknown';
}

function summarizeAchievements(list, totalHint = null) {
  const counts = {
    completed: 0,
    inProgress: 0,
    notStarted: 0,
    unknown: 0,
    totalVisible: list.length,
    totalAvailable: toFiniteIntOrNull(totalHint) ?? list.length,
  };

  for (const item of list) {
    const bucket = classifyAchievement(item);
    if (bucket === 'completed') counts.completed += 1;
    else if (bucket === 'inProgress') counts.inProgress += 1;
    else if (bucket === 'notStarted') counts.notStarted += 1;
    else counts.unknown += 1;
  }

  counts.coverage = counts.totalVisible >= counts.totalAvailable ? 'full' : 'partial';
  return counts;
}

function normalizeAccountIdentity(details) {
  const safe = details && typeof details === 'object' ? details : {};
  const account = firstText(safe.account, safe.username, safe.name, safe.code) || null;
  return {
    account,
    username: firstText(safe.username, safe.name, safe.account) || null,
    subscribed: typeof safe.subscribed === 'boolean' ? safe.subscribed : null,
  };
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startDashboardServer({
  host = process.env.DASHBOARD_HOST || '0.0.0.0',
  port = process.env.DASHBOARD_PORT || 8091,
  basePath = process.env.DASHBOARD_BASE_PATH || '',
  rootDir = process.cwd(),
  htmlFile = 'frontend/dashboard-phase1.html',
  heartbeatMs = 15_000,
  broadcastDebounceMs = 200,
  runtimeManager = null,
} = {}) {
  const resolvedPort = toPort(port, 8091);
  const resolvedHeartbeatMs = toPositiveInt(heartbeatMs, 15_000);
  const resolvedDebounceMs = toPositiveInt(broadcastDebounceMs, 200);
  const htmlPath = resolve(rootDir, htmlFile);

  if (!existsSync(htmlPath)) {
    throw new Error(`Dashboard HTML file not found: ${htmlPath}`);
  }

  const clients = new Set();
  let broadcastTimer = null;

  function broadcastSnapshot() {
    const snapshot = getUiSnapshot();
    for (const client of clients) {
      try {
        sendEvent(client.res, 'snapshot', snapshot);
      } catch {
        clients.delete(client);
      }
    }
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastSnapshot();
    }, resolvedDebounceMs);
  }

  const unsubscribeUiEvents = subscribeUiEvents(() => {
    scheduleBroadcast();
  });

  const heartbeatTimer = setInterval(() => {
    const heartbeat = { serverTimeMs: Date.now() };
    for (const client of clients) {
      try {
        sendEvent(client.res, 'heartbeat', heartbeat);
      } catch {
        clients.delete(client);
      }
    }
  }, resolvedHeartbeatMs);

  const server = createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://localhost');
      // Strip basePath prefix so routes work behind a reverse proxy (e.g. /artifacts)
      const prefix = basePath.replace(/\/+$/, '');
      let pathname = url.pathname;
      if (prefix && pathname.startsWith(prefix)) {
        pathname = pathname.slice(prefix.length) || '/';
      }

      if (url.pathname === '/api/config') {
        if (method === 'GET') {
          try {
            const snapshot = await loadConfigSnapshot();
            sendJson(res, 200, {
              path: snapshot.path,
              hash: snapshot.hash,
              config: snapshot.config,
            });
          } catch (err) {
            sendConfigError(res, err, 'config_get_failed');
          }
          return;
        }

        if (method === 'PUT') {
          let body = null;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendConfigError(res, err, 'config_put_bad_json');
            return;
          }

          if (!isObject(body)) {
            sendError(res, 400, 'bad_request', 'Body must be a JSON object', 'invalid_payload');
            return;
          }
          if (!hasOwn(body, 'config')) {
            sendError(res, 400, 'bad_request', 'Body must include "config"', 'config_required');
            return;
          }

          const ifMatchHash = firstText(body.ifMatchHash);
          if (!ifMatchHash) {
            sendError(res, 400, 'bad_request', 'Body must include non-empty "ifMatchHash"', 'if_match_required');
            return;
          }

          try {
            const validation = await validateBotConfig(body.config);
            if (!validation.ok) {
              sendError(
                res,
                422,
                'validation_failed',
                'Config validation failed',
                'config_validation_failed',
                { errors: validation.errors },
              );
              return;
            }

            const current = await loadConfigSnapshot();
            if (current.hash !== ifMatchHash) {
              sendError(
                res,
                409,
                'hash_conflict',
                'Config has changed since last read',
                'hash_conflict',
                { currentHash: current.hash },
              );
              return;
            }

            const saved = await saveConfigAtomically(body.config);
            sendJson(res, 200, {
              ok: true,
              hash: saved.hash,
              savedAtMs: saved.savedAtMs,
            });
          } catch (err) {
            sendConfigError(res, err, 'config_put_failed');
          }
          return;
        }

        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (url.pathname === '/api/config/validate') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }

        let body = null;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendConfigError(res, err, 'config_validate_bad_json');
          return;
        }

        if (!isObject(body)) {
          sendError(res, 400, 'bad_request', 'Body must be a JSON object', 'invalid_payload');
          return;
        }
        if (!hasOwn(body, 'config')) {
          sendError(res, 400, 'bad_request', 'Body must include "config"', 'config_required');
          return;
        }

        try {
          const result = await validateBotConfig(body.config);
          sendJson(res, 200, result);
        } catch (err) {
          sendConfigError(res, err, 'config_validate_failed');
        }
        return;
      }

      if (url.pathname === '/api/control/status') {
        if (method !== 'GET') {
          sendError(res, 405, 'method_not_allowed', 'Only GET is allowed', 'method_not_allowed');
          return;
        }
        if (!runtimeManager || typeof runtimeManager.getStatus !== 'function') {
          sendError(
            res,
            503,
            'runtime_control_unavailable',
            'Runtime manager is not configured',
            'runtime_control_unavailable',
          );
          return;
        }

        sendJson(res, 200, runtimeManager.getStatus());
        return;
      }

      if (url.pathname === '/api/control/reload-config') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'Only POST is allowed', 'method_not_allowed');
          return;
        }
        if (!runtimeManager || typeof runtimeManager.reloadConfig !== 'function') {
          sendError(
            res,
            503,
            'runtime_control_unavailable',
            'Runtime manager is not configured',
            'runtime_control_unavailable',
          );
          return;
        }

        try {
          const status = await runtimeManager.reloadConfig();
          sendJson(res, 200, {
            ok: true,
            operation: 'reload_config',
            status,
          });
        } catch (err) {
          sendRuntimeControlError(res, err, 'reload_config_failed');
        }
        return;
      }

      if (url.pathname === '/api/control/restart') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', 'Only POST is allowed', 'method_not_allowed');
          return;
        }
        if (!runtimeManager || typeof runtimeManager.restart !== 'function') {
          sendError(
            res,
            503,
            'runtime_control_unavailable',
            'Runtime manager is not configured',
            'runtime_control_unavailable',
          );
          return;
        }

        try {
          const status = await runtimeManager.restart();
          sendJson(res, 200, {
            ok: true,
            operation: 'restart',
            status,
          });
        } catch (err) {
          sendRuntimeControlError(res, err, 'restart_failed');
        }
        return;
      }

      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (pathname === '/') {
        try {
          let html = readFileSync(htmlPath, 'utf-8');
          // Inject basePath so frontend API calls use the correct prefix
          html = html.replace('</head>', `<script>window.__BASE_PATH__ = ${JSON.stringify(prefix)};</script>\n</head>`);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(html);
        } catch (err) {
          sendJson(res, 500, { error: 'dashboard_html_read_failed', detail: err.message });
        }
        return;
      }

      if (pathname === '/api/ui/snapshot') {
        sendJson(res, 200, getUiSnapshot());
        return;
      }

      if (pathname === '/api/ui/account/summary') {
        try {
          const detailsResult = await getCachedAccountDetails();
          const identity = normalizeAccountIdentity(detailsResult.data);

          if (!identity.account) {
            sendError(
              res,
              502,
              'upstream_error',
              'Unable to resolve account identity from /my/details',
              'account_identity_unavailable',
            );
            return;
          }

          const achievementsResult = await getCachedAccountAchievements(identity.account);
          const page = normalizeAchievementPage(achievementsResult.data);
          const counts = summarizeAchievements(page.list, page.meta.total);

          sendJson(res, 200, {
            identity,
            achievements: counts,
            metadata: {
              page: page.meta.page,
              size: page.meta.size,
              total: page.meta.total,
              pages: page.meta.pages,
              returned: page.list.length,
              detailsFetchedAtMs: detailsResult.fetchedAtMs,
              achievementsFetchedAtMs: achievementsResult.fetchedAtMs,
              detailsFromCache: detailsResult.fromCache,
              achievementsFromCache: achievementsResult.fromCache,
            },
            fetchedAtMs: Date.now(),
          });
        } catch (err) {
          sendStructuredError(res, err, 'account_summary_failed');
        }
        return;
      }

      if (pathname === '/api/ui/account/achievements') {
        try {
          const detailsResult = await getCachedAccountDetails();
          const identity = normalizeAccountIdentity(detailsResult.data);

          if (!identity.account) {
            sendError(
              res,
              502,
              'upstream_error',
              'Unable to resolve account identity from /my/details',
              'account_identity_unavailable',
            );
            return;
          }

          const params = parseAchievementQuery(url.searchParams);
          const achievementsResult = await getCachedAccountAchievements(identity.account, params);
          const page = normalizeAchievementPage(achievementsResult.data);
          const counts = summarizeAchievements(page.list, page.meta.total);

          sendJson(res, 200, {
            account: identity.account,
            achievements: page.list,
            metadata: {
              page: page.meta.page,
              size: page.meta.size,
              total: page.meta.total,
              pages: page.meta.pages,
              returned: page.list.length,
              counts,
              query: params,
              detailsFetchedAtMs: detailsResult.fetchedAtMs,
              detailsFromCache: detailsResult.fromCache,
              fromCache: achievementsResult.fromCache,
            },
            fetchedAtMs: achievementsResult.fetchedAtMs,
          });
        } catch (err) {
          sendStructuredError(res, err, 'account_achievements_failed');
        }
        return;
      }

      const detailMatch = pathname.match(/^\/api\/ui\/character\/([^/]+)$/);
      if (detailMatch) {
        let decodedName = '';
        try {
          decodedName = decodeURIComponent(detailMatch[1]).trim();
        } catch {
          sendError(res, 400, 'bad_request', 'Invalid character name encoding', 'bad_character_name');
          return;
        }

        if (!decodedName) {
          sendError(res, 400, 'bad_request', 'Character name is required', 'character_name_required');
          return;
        }

        const detail = getUiCharacterDetail(decodedName);
        if (!detail) {
          sendError(res, 404, 'character_not_found', `Unknown character "${decodedName}"`);
          return;
        }

        sendJson(res, 200, detail);
        return;
      }

      if (pathname === '/api/ui/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const client = { res };
        clients.add(client);
        sendEvent(res, 'snapshot', getUiSnapshot());

        const cleanup = () => {
          clients.delete(client);
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
      }

      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true, serverTimeMs: Date.now() });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      sendStructuredError(res, err, 'dashboard_server_error');
    }
  });

  server.on('close', () => {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    clearInterval(heartbeatTimer);
    unsubscribeUiEvents();

    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        // No-op
      }
    }
    clients.clear();
  });

  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(resolvedPort, host, resolveStart);
  });

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : resolvedPort;

  log.info(`[Dashboard] Live dashboard listening on http://${host}:${boundPort}`);

  return {
    host,
    port: boundPort,
    server,
    async close() {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}
