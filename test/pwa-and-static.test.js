'use strict';
/** Service-worker routing rules and the server's static-file safety. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DOCS = path.join(__dirname, '..', 'docs');

/* ------------------------------------------------------------------ service worker */

function loadSW() {
  const listeners = {}; const calls = { fetch: [], cachePut: [] };
  const store = new Map();
  const cacheApi = {
    open: async () => ({ addAll: async () => {}, put: async (k, v) => { calls.cachePut.push(typeof k === 'string' ? k : k.url); store.set(String(typeof k === 'string' ? k : k.url), v); } }),
    match: async req => store.get(String(typeof req === 'string' ? req : req.url)),
    keys: async () => ['localshare-v0', 'localshare-v1', 'unrelated'],
    delete: async k => { calls.deleted = (calls.deleted || []).concat(k); },
  };
  const self = { location: { origin: 'https://app.test' }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting: () => {}, clients: { claim: async () => {} } };
  const ctx = vm.createContext({ self, caches: cacheApi, URL, fetch: async req => { calls.fetch.push(req.url); return { ok: true, clone() { return this; } }; }, Promise });
  vm.runInContext(fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8'), ctx);
  const fire = req => { let responded = null; listeners.fetch({ request: req, respondWith: p => { responded = p; } }); return responded; };
  return { listeners, fire, calls };
}

test('service worker: caches the shell, ignores everything it must not touch', async () => {
  const sw = loadSW();
  assert.ok(sw.listeners.install && sw.listeners.activate && sw.listeners.fetch);
  const get = (url, mode = 'cors') => ({ method: 'GET', url, mode });
  assert.equal(sw.fire({ method: 'POST', url: 'https://app.test/x', mode: 'cors' }), null);                 // writes are never cached
  assert.equal(sw.fire(get('https://ntfy.sh/topic')), null);                                                 // third-party signalling goes straight out
  assert.equal(sw.fire(get('wss://broker.example/mqtt')), null);
  assert.equal(sw.fire(get('https://app.test/api/offer/ABCDE')), null);                                      // relay
  assert.equal(sw.fire(get('https://app.test/term/info')), null);                                            // diagnostics bridge: never cached
  assert.equal(sw.fire(get('https://app.test/localShare/term/run')), null);
  assert.ok(sw.fire(get('https://app.test/', 'navigate')));                                                  // pages: network-first
  assert.ok(sw.fire(get('https://app.test/icon-192.png')));                                                  // assets: stale-while-revalidate
  await sw.listeners.activate({ waitUntil: p => p });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sw.calls.deleted, ['localshare-v0']);                                                     // only its own old caches are removed
});

test('manifest is installable: name, scope, standalone, 192/512 PNG icons that exist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone'); assert.ok(m.name && m.short_name && m.start_url && m.scope);
  const sizes = m.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(DOCS, i.src)), i.src);
  for (const f of ['icon-192.png', 'icon-512.png']) assert.equal(fs.readFileSync(path.join(DOCS, f)).slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  const page = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  assert.match(page, /rel="manifest"/);
});

/* ------------------------------------------------------------------ server static files */

async function withServer(fn) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { await get(port, '/api/ping'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    await fn(port);
  } finally { child.kill(); }
}
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { Host: `localhost:${port}` } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});

test('server: serves the app assets with the right types', async () => {
  await withServer(async port => {
    for (const [p, type] of [['/sw.js', /javascript/], ['/manifest.webmanifest', /manifest\+json/], ['/icon.svg', /svg/], ['/icon-192.png', /png/], ['/', /html/]]) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], type, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  });
});

test('server: nothing outside docs/ is reachable (path traversal, source files, odd encodings)', async () => {
  await withServer(async port => {
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/..%5cserver.js', '/terminal/core.js', '/package.json', '/docs/../server.js', '/sw.js/../../server.js', '/%00.js', '/index.html/../../README.md', '/.git/config', '/server.js'])
      assert.notEqual((await get(port, p)).status, 200, p);
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'));
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js']) assert.ok(!(await get(port, p)).body.equals(source), p);
  });
});
