'use strict';
/** ping | trace | resolve | tcp | udp | http | mtu test | ethernet */
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const { performance } = require('perf_hooks');
const runner = require('../system/command_runner');
const platform = require('../system/platform');
const perms = require('../system/permissions');
const counters = require('../monitoring/counters');
const config = require('../config');
const { CmdError } = require('../errors');
const V = require('../system/validate');
const { fmtMs, fmtPct, fmtBytes, fmtInt, padEnd } = require('../output/terminal');

const dnsPromises = dns.promises;
const unsupported = (what, hint) => new CmdError('UNSUPPORTED_PLATFORM', `${what} is not supported on ${platform.label()}.`, { hints: hint ? [hint] : [] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================================================================ parsers & maths (pure) */

/** One line of ping output -> {seq, rtt} | {seq, status} | null.  kind: 'unix' | 'windows' */
function parsePingLine(line, kind, nextSeq = 1) {
  if (kind === 'windows') {
    let m = /^Reply from ([^:]+): .*?time([=<])(\d+)ms/i.exec(line);
    if (m) return { seq: nextSeq, rtt: Number(m[3]), approx: m[2] === '<', from: m[1] };       // 1 ms resolution; "<1ms" is reported as 1 and flagged
    if (/Request timed out|General failure/i.test(line)) return { seq: nextSeq, status: 'timeout' };
    if (/Destination (host|net|port|protocol) unreachable|TTL expired/i.test(line)) return { seq: nextSeq, status: 'unreachable', detail: line.trim() };
    return null;
  }
  let m = /icmp_seq[= ](\d+).*?time[=<]([\d.]+)\s*ms/i.exec(line);
  if (m) return { seq: Number(m[1]), rtt: Number(m[2]) };
  m = /icmp_seq[= ](\d+)\s+(Destination .*unreachable|Time to live exceeded|Frag needed.*)/i.exec(line);
  if (m) return { seq: Number(m[1]), status: 'unreachable', detail: m[2] };
  m = /Request timeout for icmp_seq (\d+)/i.exec(line);                                        // macOS
  if (m) return { seq: Number(m[1]), status: 'timeout' };
  return null;
}

function parsePingSummary(text) {
  let m = /(\d+) packets transmitted, (\d+) (?:packets )?received.*?([\d.]+)% packet loss/i.exec(text);
  if (m) return { sent: Number(m[1]), received: Number(m[2]), lossPct: Number(m[3]) };
  m = /Packets: Sent = (\d+), Received = (\d+), Lost = \d+ \((\d+)% loss\)/i.exec(text);
  if (m) return { sent: Number(m[1]), received: Number(m[2]), lossPct: Number(m[3]) };
  return null;
}

function stats(values) {
  if (!values.length) return { min: null, avg: null, max: null, stddev: null };
  const n = values.length, avg = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  return { min: Math.min(...values), avg, max: Math.max(...values), stddev: Math.sqrt(variance) };
}

const PING_DNS_ERR = /(name or service not known|temporary failure in name resolution|could not find host|cannot resolve|unknown host|no address associated)/i;

/** traceroute / tracepath / tracert line -> {hop, ips[], rtts[], timeout} | null */
function parseTraceLine(line, kind) {
  const ipRe = /\b(\d{1,3}(?:\.\d{1,3}){3})\b|\b([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})\b/gi;
  let m, rest;
  if (kind === 'tracepath') {
    m = /^\s*(\d+)\??:\s+(.*)$/.exec(line);
    if (!m) return null;
    rest = m[2];
    if (/no reply/i.test(rest)) return { hop: Number(m[1]), ips: [], rtts: [], timeout: true };
    const ips = [...rest.matchAll(ipRe)].map(x => x[0]);
    return { hop: Number(m[1]), ips: [...new Set(ips)], rtts: [...rest.matchAll(/([\d.]+)ms/g)].map(x => Number(x[1])), timeout: false };
  }
  m = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!m || /^\s*traceroute|^Tracing route|^over a maximum/i.test(line)) return null;
  rest = m[2];
  if (kind === 'tracert') {
    const rtts = [...rest.matchAll(/(<?)(\d+)\s*ms/g)].map(x => Number(x[2]));
    const tail = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{3,})\s*$/i.exec(rest.replace(/\s*\[[^\]]*\]\s*$/, ''));
    const timeout = /Request timed out/i.test(rest) || (/^\*\s+\*\s+\*/.test(rest.trim()) && !tail);
    return { hop: Number(m[1]), ips: timeout || !tail ? [] : [tail[1]], rtts, timeout };
  }
  // traceroute (Linux/macOS): "192.168.1.1  0.5 ms  0.4 ms  0.4 ms", "* * *", mixed
  const ips = [...rest.replace(/\([^)]*\)/g, ' ').matchAll(ipRe)].map(x => x[0]).filter(x => !/^\d+$/.test(x));
  const rtts = [...rest.matchAll(/([\d.]+)\s*ms/g)].map(x => Number(x[1]));
  return { hop: Number(m[1]), ips: [...new Set(ips)], rtts, timeout: !ips.length && /\*/.test(rest) };
}

/** Largest value in [lo, hi] for which `ok(size)` is true, assuming ok is monotonic (true for small sizes). */
async function searchLargest(ok, lo, hi) {
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (await ok(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const SPEED_RE = /(\d+)base[^\s/]*\/(Half|Full)/gi;
/** Collapse "10baseT/Half 10baseT/Full 1000baseT/Full" -> [{mbps:10, duplex:['Half','Full']}, {mbps:1000, duplex:['Full']}] */
function modesToSpeeds(text) {
  const map = new Map();
  for (const m of String(text || '').matchAll(SPEED_RE)) {
    const mbps = Number(m[1]);
    if (!map.has(mbps)) map.set(mbps, new Set());
    map.get(mbps).add(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase());
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([mbps, d]) => ({ mbps, duplex: [...d] }));
}

/** `ethtool <if>` -> flat map of key -> string (multi-line lists joined) */
function parseEthtool(text) {
  const out = {};
  let key = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^Settings for /.test(raw)) { key = null; continue; }
    const m = /^\t([^:\t][^:]*):\s*(.*)$/.exec(raw);
    if (m) { key = m[1].trim(); out[key] = m[2].trim(); }
    else if (key && /^\s+\S/.test(raw)) out[key] = `${out[key]} ${raw.trim()}`.trim();
  }
  return out;
}

/* ================================================================ command bodies */

async function lookupTarget(host, family, timeoutMs = 5000) {
  const t = performance.now();
  try {
    const r = await Promise.race([
      dnsPromises.lookup(host, family ? { family } : {}),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    return { ip: r.address, family: r.family, ms: performance.now() - t };
  } catch (e) {
    throw new CmdError('DNS', `cannot resolve '${host}' (${e.code === 'ENOTFOUND' ? 'name not found' : e.code || e.message}).`, { hints: ['Check the name, or inspect your resolver with: net dns'] });
  }
}

function singleTarget(arg) {
  const t = V.parseTarget(arg);
  if (t.kind === 'cidr') throw new CmdError('INVALID', `'${arg}' is a network range; this command needs a single host.`, { hints: ['To sweep a range use: scan <cidr>'] });
  return t;
}

async function doPing(ctx) {
  const [host] = ctx.args, o = ctx.opts;
  const t = singleTarget(host);
  ctx.meta.target = host;
  const count = V.parseNumber(o.count ?? config.defaults.pingCount, 'count', { min: 1, max: config.defaults.pingMaxCount, int: true });
  const size = o.size === undefined ? undefined : V.parseNumber(o.size, 'size', { min: 0, max: 65500, int: true });
  const interval = o.interval === undefined ? undefined : V.parseNumber(o.interval, 'interval', { min: 0.01, max: 60 });
  const timeout = V.parseNumber(o.timeout ?? 2, 'timeout', { min: 0.2, max: 60 });
  runner.need('ping');

  const kind = platform.isWindows ? 'windows' : 'unix';
  const v6 = t.family === 6 || o.ipv6;
  let args, bin = 'ping';
  if (platform.isWindows) {
    if (interval !== undefined) throw unsupported("ping's --interval", 'Windows ping has no interval option; omit --interval.');
    args = [...(v6 ? ['-6'] : ['-4']), '-n', count, ...(size !== undefined ? ['-l', size] : []), '-w', Math.round(timeout * 1000), host];
  } else if (platform.isMac) {
    if (v6) bin = runner.has('ping6') ? 'ping6' : 'ping';
    args = ['-n', '-c', count, ...(interval !== undefined ? ['-i', interval] : []), ...(size !== undefined ? ['-s', size] : []), host];
  } else {
    args = [...(v6 ? ['-6'] : []), '-n', '-c', count, '-W', Math.ceil(timeout), ...(interval !== undefined ? ['-i', interval] : []), ...(size !== undefined ? ['-s', size] : []), host];
  }

  ctx.out.info(`${ctx.style.head('PING')} ${host}${t.kind === 'host' ? '' : ''}\n`);
  const replies = [];  // {seq, rtt?, status?}
  let seq = 0, fromAddr = null, approx = false;
  const r = await runner.run(bin, args, {
    signal: ctx.signal, timeoutMs: (count * Math.max(interval || 1, timeout) + timeout + 10) * 1000,
    onLine: line => {
      const p = parsePingLine(line, kind, ++seq);
      if (!p) { seq--; return; }
      if (p.from) fromAddr = p.from;
      if (p.approx) approx = true;
      replies.push(p);
      if (!ctx.json && !ctx.quiet) {
        const s = ctx.style;
        ctx.out.line(p.rtt !== undefined ? `seq=${String(p.seq).padEnd(4)}${p.approx ? '<1 ms' : fmtMs(p.rtt)}` : `seq=${String(p.seq).padEnd(4)}${s.err(p.status === 'timeout' ? 'timeout' : 'unreachable')}${p.detail ? s.dim('  ' + p.detail) : ''}`);
      }
    },
  });

  const all = r.stdout + '\n' + r.stderr;
  if (!replies.length && PING_DNS_ERR.test(all)) throw new CmdError('DNS', `cannot resolve '${host}' (name not found).`, { hints: ['Check the name, or inspect your resolver with: net dns'] });
  if (!replies.length && /permission denied|operation not permitted|socket: /i.test(r.stderr)) throw new CmdError('PERMISSION', 'ping needs permission to open raw/ICMP sockets.', { hints: perms.captureHint('ping') });
  if (!replies.length && r.code !== 0 && /(invalid|illegal|bad|unknown option|usage)/i.test(r.stderr) && !r.aborted)
    throw new CmdError('INVALID', (r.stderr.trim().split('\n')[0] || 'ping rejected its arguments'), { hints: ["On Linux, intervals below 0.2 s and flood-style options need root."] });

  const summary = parsePingSummary(all);
  const rtts = replies.filter(x => x.rtt !== undefined).map(x => x.rtt);
  const allSubMs = replies.length > 0 && replies.filter(x => x.rtt !== undefined).every(x => x.approx);
  const sent = r.aborted ? Math.max(replies.length, summary ? summary.sent : 0) : (summary ? summary.sent : count);
  const received = rtts.length;
  const lossPct = sent ? ((sent - received) / sent) * 100 : null;
  const st = stats(rtts);
  const data = { target: host, address: fromAddr, sent, received, lossPct, rttMs: allSubMs ? { min: null, avg: null, max: null, stddev: null, upperBound: 1 } : st, replies: replies.map(x => ({ seq: x.seq, rttMs: x.rtt ?? null, status: x.rtt !== undefined ? 'ok' : x.status })), note: approx ? 'Windows ping reports whole milliseconds; replies under 1 ms are shown as "<1 ms" and counted as 1 ms in the statistics.' : undefined };

  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.line(`${ctx.quiet ? '' : '\n'}${s.dim('--- statistics ---')}`);
    ctx.out.kv([
      ['sent:', d.sent], ['received:', d.received], ['loss:', d.lossPct === null ? 'N/A' : (d.lossPct > 0 ? s.warn(fmtPct(d.lossPct)) : s.ok(fmtPct(d.lossPct)))], null,
      ...(d.rttMs.upperBound ? [['rtt:', '<1 ms (below the ping resolution of this system)']] : [['min:', fmtMs(d.rttMs.min)], ['avg:', fmtMs(d.rttMs.avg)], ['max:', fmtMs(d.rttMs.max)], ['stddev:', fmtMs(d.rttMs.stddev)]]),
    ], { labelWidth: 12 });
    if (!d.received) ctx.out.line(s.warn('\nNo replies. The host may be down, unreachable, or filtering ICMP.') + s.dim('\nTry `tcp <host> <port>` to test a specific service.'));
    if (d.note) ctx.out.info(s.dim('\n' + d.note));
  });
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
  if (!received) ctx.exitCode = 1;
}

async function doTrace(ctx) {
  const [host] = ctx.args, o = ctx.opts;
  const t = singleTarget(host);
  ctx.meta.target = host;
  const maxHops = V.parseNumber(o['max-hops'] ?? 30, 'max-hops', { min: 1, max: 64, int: true });
  const timeout = V.parseNumber(o.timeout ?? 2, 'timeout', { min: 0.5, max: 30 });
  const v6 = t.family === 6 || o.ipv6;

  let tool, args, kind;
  if (platform.isWindows) { runner.need('tracert'); tool = 'tracert'; kind = 'tracert'; args = [...(v6 ? ['-6'] : ['-4']), '-d', '-h', maxHops, '-w', Math.round(timeout * 1000), host]; }
  else if (runner.has('traceroute')) { tool = 'traceroute'; kind = 'traceroute'; args = [...(v6 ? ['-6'] : []), '-n', '-m', maxHops, '-w', Math.ceil(timeout), host]; }
  else if (runner.has('tracepath')) { tool = 'tracepath'; kind = 'tracepath'; args = [...(v6 ? ['-6'] : []), '-n', '-m', maxHops, host]; }
  else runner.need('traceroute', 'tracepath is also supported');

  ctx.out.info(`${ctx.style.head('TRACE')} ${host}  ${ctx.style.dim(`(${tool}, max ${maxHops} hops)`)}\n`);
  const hops = [];
  let headerSeen = '';
  const r = await runner.run(tool, args, {
    signal: ctx.signal, timeoutMs: (maxHops * (timeout * 3 + 1) + 20) * 1000,
    onLine: line => {
      const p = parseTraceLine(line, kind);
      if (!p) { headerSeen += line + '\n'; if (ctx.verbose && line.trim()) ctx.out.line(ctx.style.dim(line)); return; }
      hops.push(p);
      if (ctx.json) return;
      const s = ctx.style;
      const addr = p.ips.length ? p.ips.map(ip => ip + (V.isPrivateIP(ip) ? s.dim(' (private)') : '')).join(' / ') : s.dim('*');
      ctx.out.line(`${String(p.hop).padStart(2)}  ${padEnd(addr, 38)}${p.timeout ? s.warn('timeout') : p.rtts.map(fmtMs).join('  ')}`);
    },
  });
  const all = r.stdout + r.stderr;
  if (!hops.length && /(unknown host|name or service not known|unable to resolve|could not find host|cannot resolve|temporary failure in name)/i.test(all))
    throw new CmdError('DNS', `cannot resolve '${host}' (name not found).`);
  if (!hops.length && r.code !== 0 && !r.aborted) throw new CmdError('FAILED', (all.trim().split('\n')[0] || `${tool} failed`));
  const lastHop = hops[hops.length - 1];
  const reached = t.kind === 'ip' ? !!(lastHop && lastHop.ips.includes(host)) : null;
  ctx.out.result({ target: host, tool, hops, reachedTarget: reached }, d => {
    ctx.out.info(ctx.style.dim(`\n${d.hops.length} hops${d.hops.some(h => h.timeout) ? ' — hops shown as * did not answer (many routers rate-limit or drop probe traffic)' : ''}`));
  });
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
}

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
const DNS_FAIL = { ENOTFOUND: 'NXDOMAIN', ENODATA: null, ETIMEOUT: 'timeout', ETIMEDOUT: 'timeout', ESERVFAIL: 'SERVFAIL', ECONNREFUSED: 'refused', EREFUSED: 'refused', EBADRESP: 'bad response' };

async function doResolve(ctx) {
  const [name] = ctx.args, o = ctx.opts;
  ctx.meta.target = name;
  const timeoutMs = V.parseNumber(o.timeout ?? config.defaults.dnsTimeoutMs / 1000, 'timeout', { min: 0.5, max: 30 }) * 1000;
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  if (o.server) {
    if (!V.isIP(o.server)) throw new CmdError('INVALID', `invalid DNS server '${o.server}' (expected an IP address)`);
    resolver.setServers([o.server]);
  }
  const servers = resolver.getServers();
  if (!servers.length) throw new CmdError('UNAVAILABLE', 'no DNS servers are configured on this system.', { hints: ['Inspect with: net dns'] });

  const t0 = performance.now();
  if (V.isIP(name)) {                                              // reverse lookup
    const t = performance.now();
    let names = [], err = null;
    try { names = await resolver.reverse(name); } catch (e) { err = DNS_FAIL[e.code] === undefined ? e.code : DNS_FAIL[e.code]; }
    const data = { query: name, type: 'PTR', records: { PTR: names }, errors: err ? { PTR: err } : {}, server: servers[0], servers, queryMs: performance.now() - t };
    return ctx.out.result(data, d => {
      ctx.out.line(ctx.style.head('PTR'));
      ctx.out.line(d.records.PTR.length ? d.records.PTR.join('\n') : ctx.style.dim(d.errors.PTR ? `(${d.errors.PTR})` : '(no PTR record)'));
      ctx.out.line(`\n${ctx.style.head('DNS SERVER')}\n${d.server}\n\n${ctx.style.head('QUERY TIME')}\n${fmtMs(d.queryMs)}`);
    });
  }
  if (!V.isHostname(name)) throw new CmdError('INVALID', `invalid domain name '${name}'`);

  let types = DNS_TYPES;
  if (o.type) {
    types = String(o.type).toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
    const bad = types.find(x => !DNS_TYPES.includes(x));
    if (bad) throw new CmdError('INVALID', `unsupported record type '${bad}'`, { hints: [`Supported: ${DNS_TYPES.join(', ')}`] });
  }
  const fn = { A: n => resolver.resolve4(n), AAAA: n => resolver.resolve6(n), CNAME: n => resolver.resolveCname(n), MX: n => resolver.resolveMx(n), TXT: n => resolver.resolveTxt(n), NS: n => resolver.resolveNs(n) };
  const results = await Promise.all(types.map(async type => {
    const t = performance.now();
    try { return { type, records: await fn[type](name), ms: performance.now() - t }; }
    catch (e) { return { type, records: [], error: e.code in DNS_FAIL ? DNS_FAIL[e.code] : (e.code || e.message), code: e.code, ms: performance.now() - t }; }
  }));
  ctx.throwIfAborted();
  const total = performance.now() - t0;
  const fmtRec = (type, rec) => type === 'MX' ? (rec.exchange ? `${rec.priority}  ${rec.exchange}` : `${rec.priority}  .   (null MX: this domain accepts no mail)`) : type === 'TXT' ? rec.join('') : rec;
  const records = {}, errors = {};
  for (const r of results) { records[r.type] = r.records.map(x => fmtRec(r.type, x)); if (r.error) errors[r.type] = r.error; }

  const allNx = results.every(r => r.code === 'ENOTFOUND');
  if (allNx) throw new CmdError('DNS', `'${name}' does not exist (NXDOMAIN).`, { hints: ['Check the spelling, or query a different server: resolve <name> --server 1.1.1.1'] });
  if (results.every(r => r.error && /timeout|refused/.test(r.error)))
    throw new CmdError('TIMEOUT', `no answer from DNS server ${servers[0]}.`, { hints: ['Check connectivity to the resolver (ping ' + servers[0] + ') and your DNS settings (net dns).'] });

  ctx.out.result({ query: name, records, errors, server: servers[0], servers, queryMs: total, perType: Object.fromEntries(results.map(r => [r.type, r.ms])) }, d => {
    const s = ctx.style;
    for (const type of types) {
      ctx.out.line(s.head(type));
      if (d.records[type].length) ctx.out.line(d.records[type].join('\n'));
      else ctx.out.line(s.dim(d.errors[type] ? `(${d.errors[type]})` : '(no records)'));
      ctx.out.line();
    }
    ctx.out.line(`${s.head('DNS SERVER')}\n${d.server}${o.server ? s.dim('  (--server)') : ''}\n\n${s.head('QUERY TIME')}\n${fmtMs(d.queryMs)}`);
  });
}

async function doTcp(ctx) {
  const [host, portArg] = ctx.args, o = ctx.opts;
  const t = singleTarget(host);
  const port = V.parsePort(portArg);
  const timeoutMs = V.parseNumber(o.timeout ?? config.defaults.tcpTimeoutMs, 'timeout', { min: 50, max: 120000 });
  ctx.meta.target = `${host}:${port}`;

  let ip = host, dnsMs = null;
  if (t.kind === 'host') { const l = await lookupTarget(host, o.ipv6 ? 6 : 0); ip = l.ip; dnsMs = l.ms; }

  const outcome = await new Promise(resolve => {
    const t0 = performance.now();
    let done = false;
    const sock = net.connect({ host: ip, port });
    const finish = (result, extra = {}) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve({ result, rttMs: result === 'SUCCESS' ? performance.now() - t0 : null, ...extra }); };
    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs);
    sock.once('connect', () => finish('SUCCESS'));
    sock.once('error', e => finish(({ ECONNREFUSED: 'REFUSED', EHOSTUNREACH: 'UNREACHABLE', ENETUNREACH: 'UNREACHABLE', ECONNRESET: 'RESET', ETIMEDOUT: 'TIMEOUT', EACCES: 'BLOCKED', EPERM: 'BLOCKED' })[e.code] || 'ERROR', { error: e.code }));
    if (ctx.signal) ctx.signal.addEventListener('abort', () => finish('CANCELLED'), { once: true });
  });
  if (outcome.result === 'CANCELLED') throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });

  const data = { target: host, address: ip, port, dnsMs, result: outcome.result, rttMs: outcome.rttMs, timeoutMs, error: outcome.error };
  ctx.out.result(data, d => {
    const s = ctx.style, ok = d.result === 'SUCCESS';
    ctx.out.line(s.head('TCP CONNECT') + '\n');
    ctx.out.kv([['Target:', d.target + (d.address !== d.target ? s.dim(`  (${d.address})`) : '')], ['Port:', d.port], ...(d.dnsMs !== null ? [['DNS:', fmtMs(d.dnsMs)]] : [])], { labelWidth: 13 });
    ctx.out.line();
    ctx.out.kv([['Connection:', ok ? s.ok('SUCCESS') : d.result === 'REFUSED' ? s.err('REFUSED') : s.warn(d.result)], ...(ok ? [['RTT:', fmtMs(d.rttMs)]] : [])], { labelWidth: 13 });
    const why = { REFUSED: 'The host answered and nothing is listening on that port (RST received).', TIMEOUT: `No answer within ${d.timeoutMs} ms. The port is filtered by a firewall, or the host is down/unreachable — NOT necessarily closed.`, UNREACHABLE: 'No route to the host (network or host unreachable).', RESET: 'The connection was reset by the peer.', BLOCKED: 'The local system blocked the connection attempt.', ERROR: `Failed: ${d.error || 'unknown error'}` }[d.result];
    if (why) ctx.out.line(s.dim('\n' + why));
  });
  if (outcome.result !== 'SUCCESS') ctx.exitCode = 1;
}

async function doUdp(ctx) {
  const [host, portArg] = ctx.args, o = ctx.opts;
  const t = singleTarget(host);
  const port = V.parsePort(portArg);
  const timeoutMs = V.parseNumber(o.timeout ?? 2000, 'timeout', { min: 100, max: 60000 });
  const payload = Buffer.from(String(o.data ?? ''), 'utf8');
  ctx.meta.target = `${host}:${port}`;
  let ip = host;
  if (t.kind === 'host') ip = (await lookupTarget(host, o.ipv6 ? 6 : 0)).ip;

  const outcome = await new Promise(resolve => {
    const sock = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
    const t0 = performance.now();
    let done = false;
    const finish = (result, extra = {}) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve({ result, ...extra }); };
    const timer = setTimeout(() => finish('NO RESPONSE'), timeoutMs);
    sock.once('message', msg => finish('RESPONSE', { rttMs: performance.now() - t0, bytes: msg.length }));
    sock.once('error', e => finish(e.code === 'ECONNREFUSED' ? 'REFUSED' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'UNREACHABLE' : 'ERROR', { error: e.code }));
    sock.connect(port, ip, err => { if (err) return finish('ERROR', { error: err.code }); sock.send(payload, e => { if (e) finish(e.code === 'ECONNREFUSED' ? 'REFUSED' : 'ERROR', { error: e.code }); }); });
    if (ctx.signal) ctx.signal.addEventListener('abort', () => finish('CANCELLED'), { once: true });
  });
  if (outcome.result === 'CANCELLED') throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });

  const data = { target: host, address: ip, port, result: outcome.result, rttMs: outcome.rttMs ?? null, responseBytes: outcome.bytes ?? null, sentBytes: payload.length, error: outcome.error };
  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.line(s.head('UDP PROBE') + '\n');
    ctx.out.kv([['Target:', d.target + (d.address !== d.target ? s.dim(`  (${d.address})`) : '')], ['Port:', d.port], ['Sent:', `${d.sentBytes} bytes`]], { labelWidth: 13 });
    ctx.out.line();
    ctx.out.kv([['Result:', d.result === 'RESPONSE' ? s.ok('RESPONSE') : d.result === 'REFUSED' ? s.err('REFUSED') : s.warn(d.result)], ...(d.result === 'RESPONSE' ? [['RTT:', fmtMs(d.rttMs)], ['Reply:', `${d.responseBytes} bytes`]] : [])], { labelWidth: 13 });
    const why = { 'NO RESPONSE': 'UDP has no handshake: silence means the port is open and ignoring this payload, OR filtered. It cannot be told apart from here.', REFUSED: 'ICMP "port unreachable" received — nothing is listening.', UNREACHABLE: 'No route to the host.', ERROR: `Failed: ${d.error || 'unknown error'}` }[d.result];
    if (why) ctx.out.line(s.dim('\n' + why));
    ctx.out.info(s.dim('Tip: send an application-level probe with --data <text> for services that only reply to valid requests.'));
  });
  if (!['RESPONSE'].includes(outcome.result)) ctx.exitCode = 1;
}

async function doHttp(ctx) {
  let raw = ctx.args[0];
  const o = ctx.opts;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = 'http://' + raw;
  let url;
  try { url = new URL(raw); } catch { throw new CmdError('INVALID', `invalid URL '${ctx.args[0]}'`); }
  if (!/^https?:$/.test(url.protocol)) throw new CmdError('INVALID', `unsupported scheme '${url.protocol}' (http and https only)`);
  if (url.username || url.password) throw new CmdError('INVALID', 'credentials in URLs are not accepted (they would end up in history and logs).', { hints: ['Test the unauthenticated endpoint instead.'] });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!V.isIP(hostname) && !V.isHostname(hostname)) throw new CmdError('INVALID', `invalid host '${url.hostname}'`);
  const method = String(o.method || 'GET').toUpperCase();
  if (!/^(GET|HEAD|OPTIONS)$/.test(method)) throw new CmdError('INVALID', `method '${method}' is not allowed here (GET, HEAD, OPTIONS)`);
  const timeoutMs = V.parseNumber(o.timeout ?? config.defaults.httpTimeoutMs, 'timeout', { min: 100, max: 300000 });
  ctx.meta.target = `${url.protocol}//${url.host}`;
  const isTls = url.protocol === 'https:';
  const maxBytes = 5 * 1024 * 1024;

  const result = await new Promise((resolve, reject) => {
    const t0 = performance.now();
    const m = { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
    let tLookup = null, tConnect = null, tTls = null, bytes = 0, req;
    const mod = isTls ? https : http;
    const abort = () => { try { req.destroy(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); } catch { /* ok */ } };
    if (ctx.signal) ctx.signal.addEventListener('abort', abort, { once: true });
    req = mod.request({
      protocol: url.protocol, hostname, port: url.port || (isTls ? 443 : 80), path: url.pathname + url.search, method, agent: false, timeout: timeoutMs,
      headers: { 'User-Agent': `${config.name.toLowerCase()}/${config.version}`, Accept: '*/*', Connection: 'close' },
      servername: V.isIP(hostname) ? undefined : hostname, rejectUnauthorized: !o.insecure,
    }, res => {
      const tHead = performance.now();
      m.ttfbMs = tHead - t0;
      res.on('data', c => { bytes += c.length; if (bytes > maxBytes) res.destroy(); });
      const finish = () => {
        m.totalMs = performance.now() - t0;
        if (tLookup !== null) m.dnsMs = tLookup - t0;
        if (tConnect !== null) m.connectMs = tConnect - (tLookup !== null ? tLookup : t0);
        if (tTls !== null && tConnect !== null) m.tlsMs = tTls - tConnect;
        m.waitMs = tHead - (tTls !== null ? tTls : tConnect !== null ? tConnect : t0);
        resolve({ res, bytes, m, remote: res.socket && res.socket.remoteAddress, tlsVersion: res.socket && res.socket.getProtocol ? res.socket.getProtocol() : null });
      };
      res.on('end', finish); res.on('close', finish);
      res.on('error', () => finish());
    });
    req.on('socket', sock => {
      sock.on('lookup', () => { tLookup = performance.now(); });
      sock.on('connect', () => { tConnect = performance.now(); });
      sock.on('secureConnect', () => { tTls = performance.now(); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT_HTTP' })));
    req.on('error', e => reject(e));
    req.end();
  }).catch(e => {
    if (e.code === 'CANCELLED') throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
    const map = {
      ENOTFOUND: ['DNS', `cannot resolve '${hostname}' (name not found).`],
      ECONNREFUSED: ['UNREACHABLE', `connection refused by ${hostname}:${url.port || (isTls ? 443 : 80)} — nothing is listening there.`],
      ETIMEDOUT: ['TIMEOUT', 'connection timed out — host down or port filtered.'], ETIMEDOUT_HTTP: ['TIMEOUT', `no complete response within ${timeoutMs} ms.`],
      EHOSTUNREACH: ['UNREACHABLE', 'no route to host.'], ENETUNREACH: ['UNREACHABLE', 'network unreachable.'], ECONNRESET: ['FAILED', 'connection reset by peer.'],
    };
    if (map[e.code]) throw new CmdError(...[map[e.code][0], `${map[e.code][1]}`]);
    if (/certificate|self.signed|CERT_|ERR_TLS|SSL/i.test(`${e.code} ${e.message}`)) throw new CmdError('FAILED', `TLS error: ${e.message}`, { hints: ['For a device with a self-signed certificate, re-run with --insecure.'] });
    throw new CmdError('FAILED', e.message || 'request failed');
  });

  const { res, m } = result;
  const cl = res.headers['content-length'];
  const data = {
    url: `${url.protocol}//${url.host}${url.pathname}${url.search}`, status: res.statusCode, statusText: res.statusMessage || '', httpVersion: res.httpVersion,
    address: result.remote || null, tls: isTls ? result.tlsVersion : null,
    timingMs: { dns: m.dnsMs, connect: m.connectMs, tls: m.tlsMs, wait: m.waitMs, ttfb: m.ttfbMs, total: m.totalMs },
    contentLength: cl !== undefined ? Number(cl) : null, bytesReceived: result.bytes,
    server: res.headers.server || null, contentType: res.headers['content-type'] || null, location: res.headers.location || null,
    ...(ctx.verbose ? { headers: res.headers } : {}),
  };
  ctx.out.result(data, d => {
    const s = ctx.style, code = d.status;
    const col = code >= 500 ? s.err : code >= 400 ? s.warn : code >= 300 ? s.cyan : s.ok;
    ctx.out.line(s.head('HTTP DIAGNOSTICS') + '\n');
    ctx.out.kv([['URL:', d.url], ...(d.address ? [['ADDRESS:', d.address]] : [])], { labelWidth: 16 });
    ctx.out.line();
    const t = d.timingMs;
    ctx.out.kv([
      ['STATUS', col(`${d.status} ${d.statusText}`.trim())],
      ['DNS', t.dns === null ? s.dim('N/A (IP address)') : fmtMs(t.dns)],
      ['CONNECT', t.connect === null ? 'N/A' : fmtMs(t.connect)],
      ...(d.tls ? [['TLS', `${t.tls === null ? 'N/A' : fmtMs(t.tls)}${s.dim('  ' + d.tls)}`]] : []),
      ['WAIT (server)', fmtMs(t.wait)],
      ['TTFB', fmtMs(t.ttfb)],
      ['TOTAL', fmtMs(t.total)],
    ], { labelWidth: 16 });
    ctx.out.line();
    ctx.out.kv([
      ['CONTENT', d.contentLength !== null ? fmtBytes(d.contentLength) : `${fmtBytes(d.bytesReceived)} ${s.dim('(received; no Content-Length)')}`],
      ...(d.contentType ? [['TYPE', d.contentType]] : []), ...(d.server ? [['SERVER', d.server]] : []), ...(d.location ? [['REDIRECT TO', d.location]] : []),
    ], { labelWidth: 16 });
    ctx.out.info(s.dim('\nTTFB = request start to first response byte (includes DNS, connect, TLS). WAIT = time the server spent before answering.'));
    if (ctx.verbose && d.headers) { ctx.out.line('\n' + s.head('RESPONSE HEADERS')); for (const [k, v] of Object.entries(d.headers)) ctx.out.line(`${s.label(k + ':')} ${v}`); }
  });
}

async function doMtu(ctx) {
  const [host] = ctx.args;
  const t = singleTarget(host);
  if (t.family === 6) throw new CmdError('INVALID', 'IPv6 path MTU discovery is not supported here (IPv4 only).');
  ctx.meta.target = host;
  runner.need('ping');
  const timeoutMs = 1500;
  const probe = async size => {
    ctx.throwIfAborted();
    let args;
    if (platform.isWindows) args = ['-4', '-n', 1, '-f', '-l', size, '-w', timeoutMs, host];
    else if (platform.isMac) args = ['-n', '-c', 1, '-D', '-s', size, '-W', timeoutMs, host];
    else args = ['-n', '-c', 1, '-W', Math.ceil(timeoutMs / 1000), '-M', 'do', '-s', size, host];
    const r = await runner.run('ping', args, { signal: ctx.signal, timeoutMs: timeoutMs + 3000 });
    if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
    const out = r.stdout + r.stderr;
    if (PING_DNS_ERR.test(out)) throw new CmdError('DNS', `cannot resolve '${host}' (name not found).`);
    if (/fragment|message too long|frag needed|too large|DF set/i.test(out)) return false;
    if (platform.isWindows) return /Reply from [^:]+: bytes=\d+/i.test(out) && !/unreachable|timed out/i.test(out);
    return r.code === 0;
  };

  ctx.out.info(`${ctx.style.head('PATH MTU TEST')}  ${host}\n`);
  const log = (size, ok) => ctx.out.info(ctx.style.dim(`  probe ${String(size).padStart(5)} bytes … ${ok ? 'ok' : 'too large / no reply'}`));
  const tracked = async size => { const ok = await probe(size); log(size, ok); return ok; };

  if (!(await tracked(56)))
    throw new CmdError('UNREACHABLE', `${host} did not answer a small ping, so the path MTU cannot be measured.`, { hints: ['The host may be down or blocking ICMP. Check with: ping ' + host, 'If it only blocks ICMP, MTU cannot be probed this way.'] });
  let largest;
  if (await tracked(1472)) largest = (await tracked(8972)) ? 8972 : await searchLargest(tracked, 1473, 8971) ?? 1472;
  else largest = await searchLargest(tracked, 56, 1471);
  const mtu = largest + 28;
  const data = { target: host, largestPayloadBytes: largest, estimatedMtuBytes: mtu, headerOverheadBytes: 28 };
  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.line('\nLargest payload without fragmentation:\n' + s.bold(`${d.largestPayloadBytes} bytes`) + '\n\nEstimated IPv4 MTU:\n' + s.bold(`${d.estimatedMtuBytes} bytes`));
    const note = d.estimatedMtuBytes >= 9000 ? 'Jumbo frames are working end to end.' : d.estimatedMtuBytes === 1500 ? 'Standard Ethernet MTU.' : d.estimatedMtuBytes < 1500 ? 'Smaller than standard Ethernet — a tunnel/VPN/PPPoE hop is likely on the path.' : 'Larger than 1500 — jumbo frames are partly enabled.';
    ctx.out.line(s.dim(`\nMTU = payload + 20 (IPv4) + 8 (ICMP) bytes. ${note}`));
  });
}

async function doEthernet(ctx) {
  const name = await counters.requireInterface(V.validIface(ctx.args[0]), { signal: ctx.signal });
  ctx.meta.target = name;
  const ifs = await counters.listInterfaces({ signal: ctx.signal });
  const base = ifs.find(i => i.name === name) || {};
  let data;

  if (platform.isLinux) {
    let eth = null, limited = null;
    if (runner.has('ethtool')) {
      const r = await runner.run('ethtool', [name], { signal: ctx.signal, timeoutMs: 8000 });
      if (r.code === 0) eth = parseEthtool(r.stdout);
      else if (perms.looksLikePermissionError(r.stderr)) throw new CmdError('PERMISSION', 'ethtool needs more privileges for this interface.', { hints: perms.captureHint('ethtool') });
      else limited = (r.stderr.trim().split('\n')[0] || 'ethtool could not read this interface');
    } else limited = "ethtool is not installed";
    const sys = f => counters.readSys(name, f);
    const speed = eth && /^\d+/.test(eth.Speed || '') ? parseInt(eth.Speed, 10) : (base.speedMbps ?? null);
    data = {
      interface: name, type: base.type || null,
      link: eth ? (/yes/i.test(eth['Link detected'] || '') ? 'UP' : 'DOWN') : (sys('carrier') === '1' ? 'UP' : sys('carrier') === '0' ? 'DOWN' : base.state || 'UNKNOWN'),
      speedMbps: speed, duplex: eth && eth.Duplex && !/unknown/i.test(eth.Duplex) ? eth.Duplex : (sys('duplex') && sys('duplex') !== 'unknown' ? sys('duplex')[0].toUpperCase() + sys('duplex').slice(1) : null),
      autoNegotiation: eth ? (eth['Auto-negotiation'] || null) : null, port: eth ? eth.Port || null : null, mtu: base.mtu ?? null,
      supported: eth ? modesToSpeeds(eth['Supported link modes']) : null, advertised: eth ? modesToSpeeds(eth['Advertised link modes']) : null,
      partnerAdvertised: eth ? modesToSpeeds(eth['Link partner advertised link modes']) : null,
      source: eth ? 'ethtool' : 'sysfs', limited,
    };
  } else if (platform.isWindows) {
    const rows = await runner.psJson(`Get-NetAdapter -Name $env:NETTERM_IF -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ status = [string]$_.Status; speed = $_.Speed; full = $_.FullDuplex; media = [string]$_.PhysicalMediaType; mtu = $_.MtuSize; desc = $_.InterfaceDescription; driver = $_.DriverFileName } } | ConvertTo-Json -Compress`, { signal: ctx.signal, env: { NETTERM_IF: name } });
    const a = rows[0] || {};
    data = {
      interface: name, type: base.type || null, link: /^up$/i.test(a.status) ? 'UP' : 'DOWN', speedMbps: a.speed > 0 && a.speed < 1e15 ? Math.round(a.speed / 1e6) : null,
      duplex: base.type === 'wifi' ? null : a.full === true ? 'Full' : a.full === false ? 'Half' : null, autoNegotiation: null, port: a.media || null, mtu: a.mtu ?? null,
      supported: null, advertised: null, partnerAdvertised: null, source: 'Get-NetAdapter', description: a.desc || null,
      limited: base.type === 'wifi' ? 'Wireless link: duplex and negotiated cable modes do not apply; SPEED is the current PHY rate.' : 'Supported/advertised link modes are only exposed by ethtool (Linux).',
    };
  } else throw unsupported('Ethernet link diagnostics', 'Use: ifconfig / networksetup -getMedia');

  ctx.out.result(data, d => {
    const s = ctx.style;
    const spdList = list => list && list.length ? list.map(x => `${fmtInt(x.mbps)} Mb/s${x.duplex.length === 1 ? s.dim(` ${x.duplex[0].toLowerCase()}-duplex only`) : ''}`).join('\n') : null;
    ctx.out.kv([
      ['INTERFACE', d.interface], ['LINK', d.link === 'UP' ? s.ok('UP') : s.err(d.link)],
      ['SPEED', d.speedMbps ? `${fmtInt(d.speedMbps)} Mb/s` : (d.link === 'UP' ? 'UNAVAILABLE' : 'N/A (link down)')],
      ['DUPLEX', d.duplex || 'N/A'], ['AUTO-NEGOTIATION', d.autoNegotiation || 'N/A'], ['PORT', d.port || 'N/A'], ['MTU', d.mtu ?? 'N/A'],
      ...(d.description ? [['ADAPTER', d.description]] : []),
    ], { labelWidth: 20 });
    for (const [label, list] of [['SUPPORTED', d.supported], ['ADVERTISED', d.advertised], ['LINK PARTNER ADVERTISES', d.partnerAdvertised]]) {
      const t = spdList(list);
      if (t) ctx.out.line(`\n${s.head(label)}\n${t}`);
    }
    if (d.limited) ctx.out.line(s.warn(`\nLIMITED DATA: ${d.limited}`) + (d.source === 'sysfs' ? s.dim(`\n${(config.installHints.ethtool || '')}`) : ''));
    if (d.link === 'UP' && d.speedMbps && d.speedMbps < 1000 && d.advertised && d.advertised.some(x => x.mbps >= 1000))
      ctx.out.line(s.warn(`\nThis link negotiated only ${d.speedMbps} Mb/s although 1000 Mb/s is advertised — check the cable (pairs/length), connectors and the switch port.`));
    ctx.out.info(s.dim('\nSPEED is the negotiated link rate, not measured throughput. Measure with: bandwidth client <host>'));
  });
}

/* ================================================================ definitions */

const targetArg = { min: 1, max: 1, names: ['host'] };
const defs = [
  {
    path: 'ping', summary: 'Test reachability and measure round-trip time', usage: 'ping <host> [-c <count>] [--interval <s>] [--size <bytes>] [--timeout <s>]',
    args: targetArg,
    options: {
      count: { type: 'number', alias: 'c', desc: `packets to send (default ${config.defaults.pingCount})` },
      interval: { type: 'number', desc: 'seconds between packets (Linux/macOS; < 0.2 needs root)' },
      size: { type: 'number', alias: 's', desc: 'payload size in bytes' }, timeout: { type: 'number', alias: 'W', desc: 'per-reply timeout in seconds (default 2)' },
      ipv6: { type: 'bool', alias: '6', desc: 'force IPv6' },
    },
    examples: ['ping 192.168.1.1', 'ping 192.168.1.20 -c 10 --size 1400', 'ping example.com --json'],
    run: doPing,
  },
  {
    path: 'trace', summary: 'Trace the network path to a host, hop by hop', usage: 'trace <host> [--max-hops <n>] [--timeout <s>] [--ipv6]',
    args: targetArg,
    options: { 'max-hops': { type: 'number', desc: 'maximum hops (default 30)' }, timeout: { type: 'number', desc: 'per-probe timeout in seconds' }, ipv6: { type: 'bool', alias: '6', desc: 'force IPv6' } },
    examples: ['trace 8.8.8.8', 'trace camera.local'], run: doTrace,
  },
  {
    path: 'resolve', summary: 'DNS lookup: A, AAAA, CNAME, MX, TXT, NS (or PTR for an IP)', usage: 'resolve <domain|ip> [--type A,AAAA,MX] [--server <ip>] [--timeout <s>]',
    args: { min: 1, max: 1, names: ['domain'] },
    options: { type: { type: 'string', alias: 't', desc: 'record types, comma separated (default: all)' }, server: { type: 'string', alias: 's', desc: 'query this DNS server instead of the system resolver' }, timeout: { type: 'number', desc: 'seconds (default 5)' } },
    examples: ['resolve example.com', 'resolve example.com --type MX --server 1.1.1.1', 'resolve 192.168.1.1'], run: doResolve,
  },
  {
    path: 'tcp', summary: 'Test a TCP connection to host:port (success, refused or timeout)', usage: 'tcp <host> <port> [--timeout <ms>]',
    args: { min: 2, max: 2, names: ['host', 'port'] }, options: { timeout: { type: 'number', desc: 'milliseconds (default 3000)' }, ipv6: { type: 'bool', alias: '6', desc: 'prefer IPv6' } },
    examples: ['tcp 192.168.1.20 8080', 'tcp robot.local 22 --timeout 1000'], run: doTcp,
  },
  {
    path: 'udp', summary: 'Probe a UDP port (response, ICMP refused, or silence)', usage: 'udp <host> <port> [--data <text>] [--timeout <ms>]',
    args: { min: 2, max: 2, names: ['host', 'port'] }, options: { data: { type: 'string', desc: 'payload to send' }, timeout: { type: 'number', desc: 'milliseconds (default 2000)' }, ipv6: { type: 'bool', alias: '6', desc: 'prefer IPv6' } },
    examples: ['udp 192.168.1.20 5000', 'udp 192.168.1.1 53 --data hello'], run: doUdp,
  },
  {
    path: 'http', summary: 'HTTP/HTTPS timing: DNS, connect, TLS, TTFB, total, size', usage: 'http <url> [--method GET|HEAD|OPTIONS] [--timeout <ms>] [--insecure]',
    args: { min: 1, max: 1, names: ['url'] },
    options: { method: { type: 'string', alias: 'X', desc: 'GET (default), HEAD or OPTIONS' }, timeout: { type: 'number', desc: 'milliseconds (default 10000)' }, insecure: { type: 'bool', alias: 'k', desc: 'accept self-signed/invalid TLS certificates' } },
    examples: ['http http://192.168.1.20:8080', 'http https://example.com -v'], run: doHttp,
  },
  {
    path: 'mtu test', summary: 'Find the largest packet that crosses the path without fragmentation', usage: 'mtu test <host>',
    args: targetArg, examples: ['mtu test 192.168.1.1'], run: doMtu,
  },
  {
    path: 'ethernet', summary: 'Ethernet link diagnostics: state, negotiated speed, duplex, supported modes', usage: 'ethernet <interface>',
    args: { min: 1, max: 1, names: ['interface'] }, examples: ['ethernet eth0'], run: doEthernet,
  },
];

module.exports = Object.assign(defs, {
  parsers: { parsePingLine, parsePingSummary, stats, parseTraceLine, searchLargest, modesToSpeeds, parseEthtool },
});
