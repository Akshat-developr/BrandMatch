import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const dbPath = path.resolve(root, process.env.DATABASE_PATH || './data/brandmatch.sqlite');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const qlooCommand = process.env.QLOO_CLI || 'qloo';
const MAX_BODY = 24_000;
const MAX_TIMEOUT_MS = 90_000;

await mkdir(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS discoveries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    audience_name TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    target_type TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
`);

const insertDiscovery = db.prepare(`INSERT INTO discoveries
  (id, created_at, audience_name, signals_json, target_type, result_json)
  VALUES (?, ?, ?, ?, ?, ?)`);
const selectHistory = db.prepare(`SELECT id, created_at, audience_name, signals_json, target_type, result_json
  FROM discoveries ORDER BY created_at DESC LIMIT 25`);
const deleteDiscovery = db.prepare('DELETE FROM discoveries WHERE id = ?');

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function runQloo(operation, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(qlooCommand, ['exec', operation, '--input', JSON.stringify(input)], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, Object.assign(new Error('Qloo request timed out. Please retry once the service is available.'), { status: 504 }));
    }, MAX_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) {
        child.kill('SIGTERM');
        finish(reject, Object.assign(new Error('Qloo returned an unexpectedly large response.'), { status: 502 }));
      } else stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8_000) stderr += chunk.toString(); });
    child.on('error', err => {
      const message = err.code === 'ENOENT'
        ? 'Qloo CLI was not found. Install @qloo/qloo-harness 0.1.26 or newer, then try again.'
        : `Could not start Qloo CLI: ${err.message}`;
      finish(reject, Object.assign(new Error(message), { status: 503 }));
    });
    child.on('close', code => {
      if (settled) return;
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch {
        const detail = stderr.trim().slice(0, 500);
        return finish(reject, Object.assign(new Error(detail || 'Qloo CLI did not return a valid JSON result.'), { status: code === 0 ? 502 : 503 }));
      }
      if (code !== 0 || parsed.status === 'error') {
        const apiError = parsed?.error;
        const guidance = typeof apiError?.recovery === 'string' ? apiError.recovery : '';
        const detail = typeof apiError?.message === 'string' ? apiError.message : stderr.trim().slice(0, 500);
        const diagnostic = `${detail} ${stdout}`;
        if (/QLOO_API_KEY|api[- ]key|credential.*(?:missing|not configured)|not authenticated/i.test(diagnostic)) {
          return finish(reject, Object.assign(new Error('No Qloo credential is configured. Run `qloo setup --qloo` in your terminal and enter your event-issued credential in the private prompt, then retry. Keep the credential out of BrandMatch and project files.'), { status: 503 }));
        }
        const message = [detail || `Qloo request failed (exit ${code}).`, guidance].filter(Boolean).join(' ');
        return finish(reject, Object.assign(new Error(message), { status: 502 }));
      }
      finish(resolve, parsed);
    });
  });
}

function safeHistoryRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    audienceName: row.audience_name,
    signals: JSON.parse(row.signals_json),
    targetType: row.target_type,
    result: JSON.parse(row.result_json)
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(requested).replace(/^([/\\]*\.\.[/\\])+/, '');
  const file = path.join(publicDir, normalized);
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, 'index.html')) return json(res, 403, { error: 'Forbidden.' });
  try {
    const body = await readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, qlooCommand, storage: 'sqlite', nodeVersion: process.version });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      return json(res, 200, { items: selectHistory.all().map(safeHistoryRow) });
    }
    if (req.method === 'POST' && url.pathname === '/api/discover') {
      const body = await readBody(req);
      const audienceName = String(body.audienceName || '').trim().slice(0, 100);
      const signals = Array.isArray(body.signals)
        ? body.signals.map(x => String(x).trim()).filter(Boolean).slice(0, 8)
        : [];
      const targetType = String(body.targetType || 'brand');
      const allowedTypes = new Set(['artist', 'book', 'brand', 'movie', 'person', 'place', 'podcast', 'tv_show', 'videogame']);
      if (!audienceName) return json(res, 400, { error: 'Give this audience a short name.' });
      if (signals.length < 1) return json(res, 400, { error: 'Add at least one public cultural signal, such as a brand, artist, film, book, or place.' });
      if (signals.some(x => x.length > 160)) return json(res, 400, { error: 'Each audience signal must be 160 characters or fewer.' });
      if (!allowedTypes.has(targetType)) return json(res, 400, { error: 'Choose a supported Qloo recommendation category.' });

      const result = await runQloo('recommend', { target_type: targetType, signals, limit: 10, explain: true });
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      insertDiscovery.run(id, createdAt, audienceName, JSON.stringify(signals), targetType, JSON.stringify(result));
      return json(res, 200, { item: { id, createdAt, audienceName, signals, targetType, result } });
    }
    if (req.method === 'POST' && url.pathname === '/api/trends') {
      const body = await readBody(req);
      const entities = Array.isArray(body.entities)
        ? body.entities.map(value => String(value).trim()).filter(Boolean).slice(0, 5)
        : [];
      const entityType = String(body.entityType || 'brand');
      const days = Number(body.days);
      const allowedTypes = new Set(['artist', 'book', 'brand', 'movie', 'person', 'place', 'podcast', 'tv_show', 'videogame']);
      if (entities.length < 1) return json(res, 400, { error: 'Add at least one public entity to track.' });
      if (entities.some(value => value.length > 160)) return json(res, 400, { error: 'Each entity must be 160 characters or fewer.' });
      if (!allowedTypes.has(entityType)) return json(res, 400, { error: 'Choose a supported Qloo trend category.' });
      if (![7, 30, 90].includes(days)) return json(res, 400, { error: 'Choose a 7, 30, or 90 day trend window.' });

      const endDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const start = new Date(`${endDate}T00:00:00.000Z`);
      start.setUTCDate(start.getUTCDate() - (days - 1));
      const startDate = start.toISOString().slice(0, 10);
      const result = await runQloo('trends', {
        entities, entity_type: entityType, start_date: startDate, end_date: endDate, limit: 10
      });
      return json(res, 200, { entities, entityType, days, startDate, endDate, result });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      if (!id || id.includes('/')) return json(res, 400, { error: 'Invalid history item.' });
      deleteDiscovery.run(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      return serveStatic(req, res, url.pathname === '/' ? '/' : url.pathname.slice('/assets'.length));
    }
    if (req.method === 'GET' && ['/styles.css', '/app.js'].includes(url.pathname)) return serveStatic(req, res, url.pathname);
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    return json(res, status, { error: error.message || 'Unexpected server error.' });
  }
});

server.listen(port, host, () => {
  console.log(`BrandMatch is ready at http://${host}:${port}`);
  if (!existsSync(path.dirname(dbPath))) console.error('Database folder is unavailable.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
