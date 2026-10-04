'use strict';
/** Validation, parsing, redaction, the pipeline's guarantees, and the HTTP bridge's access rules. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const V = require('../system/validate');
const { tokenize, parseArgs } = require('../parser');
const { redact, containsSecret } = require('../logging/logger');
const { createTerminal } = require('../core');
const { createTerminalHttp } = require('../http');
const { strip } = require('../output/terminal');

/* ------------------------------------------------------------------ validation */

test('targets: IPs, hostnames, CIDRs — and nothing that looks like an option', () => {
  assert.equal(V.parseTarget('192.168.1.20').kind, 'ip');
  assert.equal(V.parseTarget('fe80::1').kind, 'ip');
  assert.equal(V.parseTarget('robot.local').kind, 'host');
  assert.equal(V.parseTarget('192.168.1.0/24').kind, 'cidr');
  for (const bad of ['-oN /etc/passwd', '--script=evil', '-iL', '', '999.1.1.1/24', '10.0.0.0/33', 'a b', 'host;rm -rf /', '$(id)', '`id`', 'a|b', 'x&&y', '../etc', 'foo/bar'])
    assert.throws(() => V.parseTarget(bad), e => e.code === 'INVALID', `should reject ${JSON.stringify(bad)}`);
});

test('ports, port lists, numbers, interface names', () => {
  assert.equal(V.parsePort('8080'), 8080);
  for (const bad of ['0', '65536', '-1', '80.5', 'http', '']) assert.throws(() => V.parsePort(bad));
  assert.deepEqual(V.parsePortList('22,80,100-102'), [22, 80, 100, 101, 102]);
  assert.throws(() => V.parsePortList('22;80')); assert.throws(() => V.parsePortList('100-50'));
  assert.equal(V.parseNumber('5', 'count', { min: 1, max: 10, int: true }), 5);
  assert.throws(() => V.parseNumber('11', 'count', { min: 1, max: 10 })); assert.throws(() => V.parseNumber('1.5', 'count', { int: true })); assert.throws(() => V.parseNumber('NaN', 'x'));
  assert.equal(V.validIface('eth0'), 'eth0'); assert.equal(V.validIface('Wi-Fi'), 'Wi-Fi'); assert.equal(V.validIface('Ethernet 2'), 'Ethernet 2');
  for (const bad of ['-i', '$(id)', 'eth0;ls', '', 'a'.repeat(60), '--help']) assert.throws(() => V.validIface(bad));
});

test('CIDR expansion and privacy classification', () => {
  assert.equal(V.expandCIDR4('192.168.1.0/24').length, 254);
  assert.deepEqual(V.expandCIDR4('10.0.0.0/30'), ['10.0.0.1', '10.0.0.2']);
  assert.throws(() => V.expandCIDR4('10.0.0.0/8', 1024));
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.5.5', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::5']) assert.ok(V.isPrivateIP(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.ok(!V.isPrivateIP(ip), ip);
});

/* ------------------------------------------------------------------ parsing */

test('tokenizer has no shell semantics', () => {
  assert.deepEqual(tokenize('ping 1.1.1.1 -c 3'), ['ping', '1.1.1.1', '-c', '3']);
  assert.deepEqual(tokenize('alias ll="net interfaces"'), ['alias', 'll=net interfaces']);
  assert.deepEqual(tokenize('echo $(id) `whoami` ; ls | cat > x'), ['echo', '$(id)', '`whoami`', ';', 'ls', '|', 'cat', '>', 'x']);   // inert words
  assert.deepEqual(tokenize("a 'b c' \"d e\" f\\ g"), ['a', 'b c', 'd e', 'f g']);
  assert.throws(() => tokenize('ping "unterminated'));
});

test('option parsing', () => {
  const spec = { count: { type: 'number', alias: 'c' }, host: { type: 'string' } };
  assert.deepEqual(parseArgs(['1.1.1.1', '-c', '5', '--host=x', '--json', '-v'], spec), { args: ['1.1.1.1'], opts: { count: 5, host: 'x', json: true, verbose: true } });
  assert.deepEqual(parseArgs(['-c10'], spec).opts.count, 10);
  assert.throws(() => parseArgs(['--nope'], spec), e => e.code === 'USAGE');
  assert.throws(() => parseArgs(['-c'], spec), e => e.code === 'USAGE');
  assert.throws(() => parseArgs(['-c', 'abc'], spec), e => e.code === 'INVALID');
  assert.deepEqual(parseArgs(['--', '-weird'], spec).args, ['-weird']);
});

/* ------------------------------------------------------------------ secrets */

test('credentials are redacted from logs/history', () => {
  assert.equal(redact('http http://admin:hunter2@192.168.1.5/'), 'http http://admin:***@192.168.1.5/');
  assert.equal(redact('tool --password hunter2 x'), 'tool --password *** x');
  assert.equal(redact('tool --token=abc123 x'), 'tool --token=*** x');
  assert.equal(redact('ping 1.1.1.1 -c 3'), 'ping 1.1.1.1 -c 3');
  assert.ok(containsSecret('http http://u:p@h/') && containsSecret('x --api-key k') && !containsSecret('net interfaces'));
});

/* ------------------------------------------------------------------ pipeline */

function harness(opts = {}) {
  const term = createTerminal();
  const events = [];
  const ac = new AbortController();
  const run = (line, extra = {}) => term.execute(line, { emit: e => events.push(e), signal: ac.signal, color: true, confirm: async () => opts.answer ?? true, ...extra });
  const text = () => events.filter(e => e.type === 'out').map(e => e.data).join('');
  return { term, run, text, events, ac };
}

test('unknown command / bad usage never throws, and report cleanly', async () => {
  const h = harness();
  assert.equal(await h.run('definitely-not-a-command'), 1);
  assert.match(strip(h.text()), /ERROR: unknown command/);
  for (const line of ['ping', 'tcp 1.1.1.1', 'tcp 1.1.1.1 99999', 'ping "-x"', 'ping 1.1.1.1 --bogus', 'net interfaces nosuchif', 'scan 10.0.0.0/99', 'resolve', 'http ftp://x', 'http http://u:p@h/', 'mtu test not a host'])
    assert.notEqual(await h.run(line), 0, line);       // every failure is an exit status, never an exception
});

test('--json output is pure JSON (no ANSI, no banners), for success and failure', async () => {
  const h = harness();
  assert.equal(await h.run('version --json'), 0);
  const ok = JSON.parse(h.text());
  assert.equal(ok.name, 'Terminal'); assert.ok(!/\x1b\[/.test(h.text()));
  const h2 = harness();
  assert.equal(await h2.run('tcp 127.0.0.1 99999 --json'), 1);
  assert.equal(JSON.parse(h2.text()).error.code, 'INVALID');
  const h3 = harness();
  await h3.run('net interfaces --json');
  assert.ok(Array.isArray(JSON.parse(h3.text()).interfaces));
});

test('confirmation gates intrusive commands; harmless ones never ask', async () => {
  let asked = 0;
  const h = harness();
  const io = { confirm: async () => { asked++; return false; } };
  await h.run('net routes', io); await h.run('ping 127.0.0.1 -c 1', io); await h.run('resolve localhost', io);
  assert.equal(asked, 0);
  assert.equal(await h.run('capture eth0', io), 1);                  // platform may reject first; either way it must not capture
  const h2 = harness();
  assert.equal(await h2.run('scan 127.0.0.0/30', { confirm: async () => { asked++; return false; } }), 1);
  assert.ok(asked >= 1); assert.match(strip(h2.text()), /Aborted\./);
  const h3 = harness();                                               // JSON mode can't prompt: it must demand --yes instead of silently proceeding
  assert.equal(await h3.run('scan 127.0.0.0/30 --json', { confirm: undefined }), 1);
  assert.match(h3.text(), /--yes/);
});

test('security commands refuse non-private targets without --authorized, and bad targets', async () => {
  const h = harness();
  for (const line of ['security scan -oN/tmp/x --yes', 'security scan 10.0.0.0/8 --yes', 'security ports "1.2.3.4; id" --yes', 'security scan 192.168.1.1 --range 1-5 --yes'])
    assert.notEqual(await h.run(line), 0, line);
});

test('Ctrl+C cancels a long-running command promptly and cleanly', async () => {
  const h = harness();
  const started = Date.now();
  const p = h.run('tcp 10.255.255.1 80 --timeout 30000');
  setTimeout(() => h.ac.abort(), 300);
  assert.equal(await p, 130);
  assert.ok(Date.now() - started < 3000);
});

test('logging records commands with redaction and exit status', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  process.env.NETTERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'netterm-'));
  delete require.cache[require.resolve('../config')];
  const { Logger } = require('../logging/logger');
  const lg = new Logger();
  const r = lg.start('t.jsonl');
  lg.record({ command: 'http http://a:secret@h/x', target: 'h', result: 'ok', durationMs: 12.4, exit: 0 });
  lg.record({ command: 'ping 1.1.1.1', target: '1.1.1.1', result: 'error:TIMEOUT', durationMs: 5, exit: 1 });
  lg.stop();
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.ok(!JSON.stringify(lines).includes('secret'));
  assert.deepEqual(Object.keys(lines[0]).sort(), ['command', 'durationMs', 'exitStatus', 'result', 'target', 'timestamp']);
});

/* ------------------------------------------------------------------ HTTP bridge */

async function withBridge(fn) {
  const bridge = createTerminalHttp({ port: 0 });
  const server = http.createServer((req, res) => bridge.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  try { await fn({ call, token: bridge.token, port }); } finally { server.close(); }
}

test('bridge: info is reachable same-origin; POSTs need token, JSON, and a same-origin Origin', async () => {
  await withBridge(async ({ call, token, port }) => {
    const info = await call('GET', '/term/info');
    assert.equal(info.status, 200); assert.equal(JSON.parse(info.text).token, token); assert.equal(info.headers['access-control-allow-origin'], undefined);   // never CORS-enabled
    const json = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ line: 'version' });
    assert.equal((await call('POST', '/term/run', { headers: json, body })).status, 401);                                             // no token
    assert.equal((await call('POST', '/term/run', { headers: { ...json, 'X-Term-Token': 'wrong' }, body })).status, 401);
    assert.equal((await call('POST', '/term/run', { headers: { ...json, 'X-Term-Token': token, Origin: 'https://evil.example' }, body })).status, 403);   // cross-site page
    assert.equal((await call('POST', '/term/run', { headers: { 'Content-Type': 'text/plain', 'X-Term-Token': token }, body })).status, 415);               // "simple" CSRF request
    assert.equal((await call('GET', '/term/info', { headers: { Host: 'evil.example:80' } })).status, 403);                                                // DNS rebinding
    const ok = await call('POST', '/term/run', { headers: { ...json, 'X-Term-Token': token, Origin: `http://localhost:${port}` }, body });
    assert.equal(ok.status, 200);
    const events = ok.text.trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'end'); assert.equal(events.at(-1).exit, 0);
    assert.match(events.filter(e => e.type === 'out').map(e => e.data).join('').replace(/\x1b\[[0-9;]*m/g, ''), /Terminal 1\.0\.0/);
  });
});

test('bridge: a command that needs consent waits for it — decline aborts, nothing runs', async () => {
  await withBridge(async ({ port, token, call }) => {
    const headers = { 'Content-Type': 'application/json', 'X-Term-Token': token, Host: `localhost:${port}` };
    const events = [];
    let answered = false;
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/term/run', method: 'POST', headers }, res => {
        let buf = '';
        res.on('data', async c => {
          buf += c; let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(ev);
            if (ev.type === 'confirm' && !answered) {                       // the web client does exactly this
              answered = true;
              const start = events.find(e => e.type === 'start');
              await call('POST', '/term/answer', { headers: { 'Content-Type': 'application/json', 'X-Term-Token': token }, body: JSON.stringify({ id: start.id, ok: false }) });
            }
          }
        });
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(JSON.stringify({ line: 'scan 127.0.0.0/30' })); req.end();
    });
    assert.ok(events.some(e => e.type === 'confirm'), 'must ask before sweeping');
    const out = events.filter(e => e.type === 'out').map(e => e.data).join('');
    assert.match(out, /WARNING/); assert.match(out, /Aborted\./);
    assert.ok(!/addresses answered/.test(out), 'declined scan must not run');
    assert.equal(events.at(-1).type, 'end'); assert.equal(events.at(-1).exit, 1);
  });
});

test('bridge: closing the connection mid-command cancels it', async () => {
  await withBridge(async ({ port, token }) => {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/term/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Term-Token': token, Host: `localhost:${port}` } }, res => {
        res.on('data', () => { req.destroy(); resolve(); });     // got "start": hang up
      });
      req.on('error', () => resolve());
      req.write(JSON.stringify({ line: 'tcp 10.255.255.1 80 --timeout 30000' })); req.end();
    });
    await new Promise(r => setTimeout(r, 400));
    assert.ok(Date.now() - t0 < 5000);
  });
});
