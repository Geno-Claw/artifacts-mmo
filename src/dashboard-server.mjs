import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import * as log from './log.mjs';
import { getUiSnapshot, subscribeUiEvents } from './services/ui-state.mjs';

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

  const server = createServer((req, res) => {
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
