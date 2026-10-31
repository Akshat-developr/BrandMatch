import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('local app serves its UI, validates trend dates, and saves no fabricated Qloo output', async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'brandmatch-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const capturePath = path.join(tempDir, 'qloo-input.json');
  const fakeCliPath = path.join(tempDir, 'qloo-test-stub.mjs');
  await writeFile(fakeCliPath, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const [command, operation] = process.argv.slice(2);
const input = JSON.parse(process.argv.at(-1));
await writeFile(process.env.BRANDMATCH_TEST_CAPTURE, JSON.stringify({ command, operation, input }));
console.log(JSON.stringify({ status: 'error', error: { code: 'test_stub', layer: 'test', retryable: false, recovery: 'No live Qloo request was made.' } }));
process.exitCode = 1;
`);
  await chmod(fakeCliPath, 0o755);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: path.join(tempDir, 'test.sqlite'),
      QLOO_CLI: fakeCliPath,
      BRANDMATCH_TEST_CAPTURE: capturePath
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local server to bind. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'app should start on the configured local port');

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const markup = await page.text();
  assert.match(markup, /Find your audience/);
  assert.match(markup, /REAL QLOO TRENDS/);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.storage, 'sqlite');

  const invalid = await fetch(`${base}/api/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audienceName: 'Test audience', signals: [], targetType: 'brand' })
  });
  assert.equal(invalid.status, 400);

  const invalidTrend = await fetch(`${base}/api/trends`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: [], entityType: 'brand', days: 30 })
  });
  assert.equal(invalidTrend.status, 400);

  const invalidTrendWindow = await fetch(`${base}/api/trends`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: ['Public brand'], entityType: 'brand', days: 13 })
  });
  assert.equal(invalidTrendWindow.status, 400);

  const trendResult = await fetch(`${base}/api/trends`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: ['Public brand', 'Second public brand'], entityType: 'brand', days: 7 })
  });
  assert.equal(trendResult.status, 502, 'the test CLI returns an explicit error rather than fake trend data');
  assert.match((await trendResult.json()).error, /No live Qloo request was made/);
  const captured = JSON.parse(await readFile(capturePath, 'utf8'));
  assert.equal(captured.command, 'exec');
  assert.equal(captured.operation, 'trends');
  assert.deepEqual(captured.input.entities, ['Public brand', 'Second public brand']);
  assert.equal(captured.input.entity_type, 'brand');
  assert.equal(captured.input.limit, 10);
  const endDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const expectedStart = new Date(`${endDate}T00:00:00.000Z`);
  expectedStart.setUTCDate(expectedStart.getUTCDate() - 6);
  assert.equal(captured.input.end_date, endDate);
  assert.equal(captured.input.start_date, expectedStart.toISOString().slice(0, 10));

  const failedDiscovery = await fetch(`${base}/api/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audienceName: 'Test audience', signals: ['Public cultural signal'], targetType: 'brand' })
  });
  assert.equal(failedDiscovery.status, 502);

  const history = await (await fetch(`${base}/api/history`)).json();
  assert.deepEqual(history.items, [], 'test errors must not be saved as Qloo insights');
});
