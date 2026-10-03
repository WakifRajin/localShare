'use strict';
/** scan --local | scan <target> | scan --ports <target> */
const net = require('net');
const dns = require('dns').promises;
const { performance } = require('perf_hooks');
const runner = require('../system/command_runner');
const platform = require('../system/platform');
const perms = require('../system/permissions');
const counters = require('../monitoring/counters');
const config = require('../config');
const { CmdError } = require('../errors');
const V = require('../system/validate');
const diag = require('./diagnostics');
const network = require('./network');
const { fmtMs, fmtInt } = require('../output/terminal');

const SERVICES = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 67: 'dhcp', 80: 'http', 110: 'pop3', 111: 'rpcbind', 123: 'ntp', 135: 'msrpc', 139: 'netbios-ssn',
  143: 'imap', 161: 'snmp', 389: 'ldap', 443: 'https', 445: 'smb', 502: 'modbus', 515: 'printer', 554: 'rtsp', 631: 'ipp', 993: 'imaps', 995: 'pop3s', 1883: 'mqtt',
  2049: 'nfs', 3306: 'mysql', 3389: 'rdp', 5000: 'upnp/flask', 5432: 'postgresql', 5555: 'adb', 5900: 'vnc', 6379: 'redis', 7447: 'zenoh', 8000: 'http-alt',
  8080: 'http-proxy', 8443: 'https-alt', 8554: 'rtsp-alt', 8883: 'mqtt-tls', 9090: 'http-alt/rosbridge', 11311: 'ros-master', 11434: 'ollama', 47808: 'bacnet',
};
// Common management, web, media-streaming and robotics ports — a small, non-aggressive default set.
const DEFAULT_PORTS = [21, 22, 23, 25, 53, 80, 110, 111, 123, 135, 139, 143, 161, 389, 443, 445, 502, 554, 631, 993, 995, 1883, 2049, 3306, 3389, 5000, 5432, 5555, 5900, 6379, 7447, 8000, 8080, 8443, 8554, 8883, 9090, 11311];

/* ================================================================ helpers */

/** Single ICMP echo through the system ping. @returns {{up:boolean, rttMs:number|null}} */
async function pingOnce(ip, { timeoutMs = 1000, signal } = {}) {
  let args;
  if (platform.isWindows) args = [net.isIPv6(ip) ? '-6' : '-4', '-n', 1, '-w', timeoutMs, ip];
  else if (platform.isMac) args = ['-n', '-c', 1, '-W', timeoutMs, ip];
  else args = [...(net.isIPv6(ip) ? ['-6'] : []), '-n', '-c', 1, '-W', Math.max(1, Math.ceil(timeoutMs / 1000)), ip];
  const r = await runner.run('ping', args, { signal, timeoutMs: timeoutMs + 3000 });
  let rtt = null;
  for (const line of r.stdout.split('\n')) { const p = diag.parsers.parsePingLine(line.trim(), platform.isWindows ? 'windows' : 'unix', 1); if (p && p.rtt !== undefined) rtt = p.rtt; }
  return { up: rtt !== null, rttMs: rtt };
}

async function reverseName(ip, ms = 1500) {
  try {
    const r = await Promise.race([dns.reverse(ip), new Promise((_, rej) => setTimeout(() => rej(new Error('t')), ms))]);
    return r[0] || null;
  } catch { return null; }
}

async function pool(items, limit, worker, signal) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !(signal && signal.aborted)) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

/** true if every address the target resolves to is on a private/loopback/link-local network */
async function targetIsPrivate(t) {
  if (t.kind === 'ip') return V.isPrivateIP(t.value);
  if (t.kind === 'cidr') return V.isPrivateIP(t.cidr.ip);
  try { const all = await dns.lookup(t.value, { all: true }); return all.length > 0 && all.every(a => V.isPrivateIP(a.address)); } catch { return false; }
}

/** TCP connect probe. result: open | closed (RST) | filtered (no answer / unreachable) */
function probePort(ip, port, timeoutMs) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const s = net.connect({ host: ip, port });
    let done = false;
    const end = (state, rttMs = null) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve({ port, state, rttMs }); };
    const timer = setTimeout(() => end('filtered'), timeoutMs);
    s.once('connect', () => end('open', performance.now() - t0));
    s.once('error', e => end(e.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
  });
}

/** arp-scan output -> [{ip, mac, vendor}] */
function parseArpScan(text) {
  const rows = [];
  for (const l of text.split('\n')) { const m = /^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*(.*)$/i.exec(l.trim()); if (m) rows.push({ ip: m[1], mac: m[2].toLowerCase(), vendor: m[3] || null }); }
  return rows;
}

/* ================================================================ scan modes */

async function scanLocal(ctx) {
  const ifs = (await counters.listInterfaces({ signal: ctx.signal })).filter(i => i.type !== 'loopback');
  const own = ifs.flatMap(i => (i.ipv4.length ? i.ipv4 : [null]).map(a => ({ interface: i.name, ip: a ? a.split('/')[0] : null, subnet: a, mac: i.mac, status: i.state })));
  const neighbors = (await network.getNeighbors(ctx)).filter(n => n.mac && !/^(FAILED|INCOMPLETE)$/.test(n.state || '') && !network.isNoiseNeighbor(n));

  let active = null;
  if (ctx.opts.active) {
    if (!runner.has('arp-scan')) throw new CmdError('MISSING_DEPENDENCY', "'arp-scan' is not installed.", { hints: [config.installHints['arp-scan'] ? `Install it with: ${config.installHints['arp-scan']}` : 'Install arp-scan.', 'Passive results (neighbor table) are still available without --active.'] });
    const args = ['--localnet', ...(ctx.opts.interface ? ['--interface', V.validIface(ctx.opts.interface)] : [])];
    ctx.out.info(ctx.style.dim('Running arp-scan on the local segment…'));
    const r = await runner.run('arp-scan', args, { signal: ctx.signal, timeoutMs: 120000 });
    if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
    if (perms.looksLikePermissionError(r.stderr)) throw new CmdError('PERMISSION', 'arp-scan needs raw-socket privileges.', { hints: perms.captureHint('arp-scan') });
    if (r.code !== 0) throw new CmdError('FAILED', r.stderr.trim().split('\n')[0] || 'arp-scan failed');
    active = parseArpScan(r.stdout);
  }
  ctx.out.result({ local: own, neighbors, ...(active ? { arpScan: active } : {}) }, d => {
    const s = ctx.style;
    ctx.out.table([{ key: 'interface', title: 'INTERFACE' }, { key: 'ip', title: 'IP' }, { key: 'mac', title: 'MAC' }, { key: 'status', title: 'STATUS', color: t => t === 'UP' ? s.ok(t) : t === 'DOWN' ? s.err(t) : t }], d.local);
    if (d.arpScan) {
      ctx.out.line('\n' + s.head('DEVICES FOUND BY ARP-SCAN'));
      ctx.out.table([{ key: 'ip', title: 'IP' }, { key: 'mac', title: 'MAC' }, { key: 'vendor', title: 'VENDOR' }], d.arpScan);
    } else {
      ctx.out.line('\n' + s.head('DEVICES RECENTLY SEEN (neighbor table)'));
      ctx.out.table([{ key: 'ip', title: 'IP' }, { key: 'mac', title: 'MAC' }, { key: 'interface', title: 'INTERFACE' }, { key: 'state', title: 'STATE' }], d.neighbors);
      ctx.out.info(s.dim('\nPassive view only — nothing was sent. For active ARP discovery add --active (needs arp-scan + root), or sweep a subnet: scan 192.168.1.0/24'));
    }
  });
}

async function scanHost(ctx, t) {
  const ip = t.kind === 'ip' ? t.value : (await dns.lookup(t.value).catch(() => { throw new CmdError('DNS', `cannot resolve '${t.value}' (name not found).`); })).address;
  const [echo, name] = await Promise.all([pingOnce(ip, { timeoutMs: 2000, signal: ctx.signal }), t.kind === 'ip' ? reverseName(ip) : Promise.resolve(t.value)]);
  let mac = null;
  try { const n = (await network.getNeighbors(ctx)).find(x => x.ip === ip); mac = n ? n.mac : null; } catch { /* neighbor table unavailable */ }
  const data = { target: t.value, address: ip, status: echo.up ? 'UP' : 'NO RESPONSE', rttMs: echo.rttMs, hostname: name, mac, onLink: !!mac };
  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.kv([['TARGET', d.target], ['ADDRESS', d.address], ['STATUS', d.status === 'UP' ? s.ok('UP') : s.warn('NO RESPONSE')], ['RTT', fmtMs(d.rttMs)], ['HOSTNAME', d.hostname || 'N/A'], ['MAC', d.mac || 'N/A' + (d.status === 'UP' ? s.dim(' (not on this subnet, or not yet in the neighbor table)') : '')]]);
    if (d.status !== 'UP') ctx.out.info(s.dim('\nNo ICMP reply: the host may be down, or filtering ping. Try a service probe: tcp ' + d.address + ' <port>'));
  });
  if (!echo.up) ctx.exitCode = 1;
}

async function sweep(ctx, t) {
  if (t.family !== 4) throw new CmdError('INVALID', 'only IPv4 ranges can be swept.');
  const hosts = V.expandCIDR4(t.cidr, config.defaults.sweepMaxHosts);
  const found = [];
  let done = 0;
  const started = Date.now();
  const frame = () => ctx.out.frame(`${ctx.style.dim('sweeping')} ${done}/${hosts.length}  ${ctx.style.dim(`${found.length} up · ${Math.round((Date.now() - started) / 1000)}s`)}`);
  frame();
  const tick = setInterval(frame, 400);
  try {
    await pool(hosts, config.defaults.sweepConcurrency, async ip => {
      const r = await pingOnce(ip, { timeoutMs: 1000, signal: ctx.signal });
      done++;
      if (r.up) found.push({ ip, rttMs: r.rttMs });
    }, ctx.signal);
  } finally { clearInterval(tick); }
  ctx.throwIfAborted();
  frame();
  let neigh = [];
  try { neigh = await network.getNeighbors(ctx); } catch { /* optional */ }
  found.sort((a, b) => V.ipv4ToInt(a.ip) - V.ipv4ToInt(b.ip));
  for (const f of found) f.mac = (neigh.find(n => n.ip === f.ip) || {}).mac || null;
  if (ctx.verbose) await pool(found, 8, async f => { f.hostname = await reverseName(f.ip); });
  ctx.out.result({ target: t.value, scanned: hosts.length, up: found.length, hosts: found }, d => {
    ctx.out.line('');
    ctx.out.table([{ key: 'ip', title: 'IP' }, { key: 'rttMs', title: 'RTT', format: v => fmtMs(v), align: 'right' }, { key: 'mac', title: 'MAC' }, ...(ctx.verbose ? [{ key: 'hostname', title: 'HOSTNAME' }] : [])], d.hosts, { empty: '(no hosts answered)' });
    ctx.out.line(ctx.style.dim(`\n${d.up} of ${fmtInt(d.scanned)} addresses answered ICMP echo. Hosts that block ping will not appear.`));
  });
}

async function scanPorts(ctx, t) {
  if (t.kind === 'cidr') throw new CmdError('INVALID', 'port scans take a single host. Use `security ports` (nmap) for ranges.');
  const ip = t.kind === 'ip' ? t.value : (await dns.lookup(t.value).catch(() => { throw new CmdError('DNS', `cannot resolve '${t.value}' (name not found).`); })).address;
  const ports = ctx.opts.range ? V.parsePortList(ctx.opts.range) : DEFAULT_PORTS;
  const timeoutMs = V.parseNumber(ctx.opts.timeout ?? config.defaults.scanTimeoutMs, 'timeout', { min: 100, max: 10000 });
  const results = [];
  let done = 0;
  const frame = () => ctx.out.frame(`${ctx.style.dim('probing')} ${done}/${ports.length}  ${ctx.style.dim(`${results.filter(r => r.state === 'open').length} open`)}`);
  frame();
  const tick = setInterval(frame, 300);
  try {
    await pool(ports, config.defaults.scanConcurrency, async p => { results.push(await probePort(ip, p, timeoutMs)); done++; }, ctx.signal);
  } finally { clearInterval(tick); }
  ctx.throwIfAborted();
  results.sort((a, b) => a.port - b.port);
  const count = st => results.filter(r => r.state === st).length;
  const data = { target: t.value, address: ip, scannedPorts: ports.length, open: count('open'), closed: count('closed'), filtered: count('filtered'), ports: results.filter(r => ctx.verbose || r.state === 'open').map(r => ({ ...r, service: SERVICES[r.port] || null })) };
  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.line('');
    ctx.out.kv([['TARGET', d.target + (d.address !== d.target ? s.dim(`  (${d.address})`) : '')], ['SCANNED', `${fmtInt(d.scannedPorts)} TCP ports (connect scan)`]], { labelWidth: 10 });
    ctx.out.line();
    ctx.out.table([
      { key: 'port', title: 'PORT', align: 'right' }, { key: 'state', title: 'STATE', color: x => x === 'open' ? s.ok(x) : x === 'closed' ? s.dim(x) : s.warn(x) },
      { key: 'service', title: 'SERVICE', format: v => v || 'unknown' }, { key: 'rttMs', title: 'RTT', format: v => v === null ? '-' : fmtMs(v), align: 'right' },
    ], d.ports, { empty: '(no open ports found)' });
    ctx.out.line(s.dim(`\nopen: ${d.open}   closed (refused): ${d.closed}   filtered (no answer): ${d.filtered}`));
    ctx.out.info(s.dim('SERVICE names are the conventional assignment for that port number — not a fingerprint of what is actually running. Use `security services` for version detection.'));
  });
}

/* ================================================================ definition */

const def = {
  path: 'scan',
  summary: 'Discover devices and open ports (non-aggressive; confirms before anything noisy)',
  usage: 'scan --local [--active] | scan <host|cidr> | scan --ports <host> [--range 1-1024]',
  args: { min: 0, max: 1, names: ['target'] },
  options: {
    local: { type: 'bool', desc: 'show local interfaces and devices seen on the LAN (passive)' },
    ports: { type: 'bool', desc: 'TCP connect-scan the target\'s ports (default: ~40 common ones)' },
    range: { type: 'string', desc: 'ports to scan, e.g. 1-1024 or 22,80,443' },
    active: { type: 'bool', desc: 'with --local: ARP-scan the subnet (needs arp-scan and root)' },
    interface: { type: 'string', alias: 'i', desc: 'with --active: interface to scan on' },
    timeout: { type: 'number', desc: 'per-port timeout in ms (default 800)' },
  },
  examples: ['scan --local', 'scan 192.168.1.20', 'scan 192.168.1.0/24', 'scan --ports 192.168.1.20', 'scan --ports 192.168.1.20 --range 1-1024'],

  async confirm(ctx) {
    const o = ctx.opts, target = ctx.args[0];
    if (o.local) return o.active ? { title: 'WARNING', lines: ['Active ARP scan: broadcasts an ARP request for every address on the local subnet.', '', 'Run it only on networks you own or administer.'], prompt: 'Continue?' } : null;
    if (!target) return null;
    const t = V.parseTarget(target);
    const lines = [];
    if (!(await targetIsPrivate(t))) lines.push('This target is NOT on a private network.', 'Only scan systems you own or are explicitly authorized to test.', '');
    if (t.kind === 'cidr') { lines.push('This scan sends one ICMP echo to every address in the range and may generate significant network traffic.', '', 'Target:', target); }
    else if (o.ports) {
      const n = o.range ? V.parsePortList(o.range).length : DEFAULT_PORTS.length;
      if (n > 100 || lines.length) lines.push(`This opens a TCP connection to ${n} ports on the target.`, '', 'Target:', target);
    }
    return lines.length ? { title: 'WARNING', lines, prompt: 'Continue?' } : null;
  },

  async run(ctx) {
    const o = ctx.opts, target = ctx.args[0];
    if (o.local) return scanLocal(ctx);
    if (!target) throw new CmdError('USAGE', 'missing target.', { hints: ['Usage: ' + def.usage] });
    const t = V.parseTarget(target);
    ctx.meta.target = target;
    if (o.ports) return scanPorts(ctx, t);
    if (t.kind === 'cidr') return sweep(ctx, t);
    return scanHost(ctx, t);
  },
};

module.exports = Object.assign([def], { parsers: { parseArpScan }, probePort, DEFAULT_PORTS, SERVICES, targetIsPrivate, pool });
