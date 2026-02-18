#!/usr/bin/env node
/**
 * Simple static file server for the Artifacts MMO report.
 * Serves /home/claw/artifacts-mmo/report on port 8090.
 * Access via Tailscale: http://ubuntu-claw.tail4c5974.ts.net:8090
 */
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

const PORT = 8090;
const ROOT = '/home/claw/artifacts-mmo/report';

const MIME = { '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

createServer((req, res) => {
  let filePath = join(ROOT, req.url === '/' ? 'index.html' : req.url);
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(filePath));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Report server running on http://0.0.0.0:${PORT}`);
});
