import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import * as log from './log.mjs';
import { getCachedAccountAchievements, getCachedAccountDetails } from './services/account-cache.mjs';
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

function sendError(res, status, error, detail, code = error) {
  const payload = { error };
  if (detail) payload.detail = detail;
  if (code) payload.code = code;
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
