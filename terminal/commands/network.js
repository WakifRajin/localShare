'use strict';
/** net interfaces | routes | neighbors | connections | ports | dns | stats   and   route <destination> */
const os = require('os');
const fs = require('fs');
const dns = require('dns').promises;
const runner = require('../system/command_runner');
const platform = require('../system/platform');
const perms = require('../system/permissions');
const counters = require('../monitoring/counters');
const { CmdError } = require('../errors');
const { parseTarget, isIP } = require('../system/validate');
const { fmtBytes, fmtInt, na } = require('../output/terminal');

const unsupported = (what, hint) => new CmdError('UNSUPPORTED_PLATFORM', `${what} is not supported on ${platform.label()}.`, { hints: hint ? [hint] : [] });

/* ================================================================ parsers (pure) */

/** `ip -j route [get X]`  ->  [{destination, gateway, interface, source, metric, protocol}] */
function parseRoutesJson(arr) {
  return (arr || []).map(r => ({
    destination: r.dst === undefined ? 'default' : r.dst,
    gateway: r.gateway || (r.type === 'local' || r.type === 'broadcast' ? null : 'direct'),
    interface: r.dev || null,
    source: r.prefsrc || null,
    metric: r.metric !== undefined ? r.metric : null,
    protocol: r.protocol || null,
    type: r.type || 'unicast',
  }));
}

/** `ip -j neigh` -> [{ip, mac, interface, state}] */
function parseNeighJson(arr) {
  return (arr || []).map(n => ({
    ip: n.dst, mac: n.lladdr || null, interface: n.dev || null,
    state: Array.isArray(n.state) ? n.state.join(',') : (n.state || null),
  }));
}

/** `arp -an` (macOS/BSD) */
function parseArpAn(text) {
  const rows = [];
  for (const l of text.split('\n')) {
    const m = /\((\d+\.\d+\.\d+\.\d+)\) at (\S+) on (\S+)/.exec(l);
    if (m) rows.push({ ip: m[1], mac: /incomplete/.test(m[2]) ? null : m[2], interface: m[3], state: /incomplete/.test(m[2]) ? 'INCOMPLETE' : 'REACHABLE' });
  }
  return rows;
}

const SS_STATE = { ESTAB: 'ESTABLISHED', UNCONN: '-', 'SYN-SENT': 'SYN_SENT', 'SYN-RECV': 'SYN_RECV', 'FIN-WAIT-1': 'FIN_WAIT_1', 'FIN-WAIT-2': 'FIN_WAIT_2', 'TIME-WAIT': 'TIME_WAIT', 'CLOSE-WAIT': 'CLOSE_WAIT', 'LAST-ACK': 'LAST_ACK' };

/** `ss -tunap` / `ss -tulpn` output (header optional) */
function parseSs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^(tcp|udp|raw|sctp)6?\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/i.exec(line.trim());
    if (!m) continue;
    const proc = /users:\(\("([^"]*)",pid=(\d+)/.exec(m[7] || '');
    const state = SS_STATE[m[2]] || m[2];
    rows.push({
      proto: m[1].toUpperCase(), state,
      local: m[5].replace(/^\*:/, '0.0.0.0:'), remote: m[6],
      process: proc ? proc[1] : null, pid: proc ? Number(proc[2]) : null,
      recvQ: Number(m[3]), sendQ: Number(m[4]),
    });
  }
  return rows;
}

/** Windows `netstat -ano` (+ pid->name map) */
function parseNetstatWin(text, names = new Map()) {
  const rows = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'TCP' && p.length >= 5) {
      const pid = Number(p[4]);
      rows.push({ proto: 'TCP', state: p[3] === 'LISTENING' ? 'LISTEN' : p[3], local: p[1], remote: p[2], process: names.get(pid) || null, pid });
    } else if (p[0] === 'UDP' && p.length >= 4) {
      const pid = Number(p[3]);
      rows.push({ proto: 'UDP', state: '-', local: p[1], remote: p[2], process: names.get(pid) || null, pid });
    }
  }
  return rows;
}

/** `tasklist /FO CSV /NH` -> Map(pid -> image name) */
function parseTasklist(text) {
  const map = new Map();
  for (const l of text.split('\n')) { const m = /^"([^"]+)","(\d+)"/.exec(l.trim()); if (m) map.set(Number(m[2]), m[1]); }
  return map;
}

/** /proc/net/snmp -> { Ip: {InReceives: n,...}, Tcp: {...}, Udp: {...}, Icmp: {...} } */
function parseSnmp(text) {
  const out = {};
  const lines = text.split('\n').filter(Boolean);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const [h, ...keys] = lines[i].split(/\s+/), [h2, ...vals] = lines[i + 1].split(/\s+/);
    if (h !== h2) continue;
    const proto = h.replace(':', '');
    out[proto] = {};
    keys.forEach((k, j) => { if (k) out[proto][k] = Number(vals[j]); });
  }
  return out;
}

/** `resolvectl dns` -> [{interface, servers}] */
function parseResolvectlDns(text) {
  const out = [];
  for (const l of text.split('\n')) {
    const m = /^(?:Link|Global)\s*(?:\d+\s*)?(?:\(([^)]*)\))?:\s*(.*)$/.exec(l.trim());
    if (m && m[2].trim()) out.push({ interface: m[1] || 'global', servers: m[2].trim().split(/\s+/) });
  }
  return out;
}

/* ================================================================ helpers */

async function resolveDestination(dest, signal) {
  const t = parseTarget(dest);
  if (t.kind === 'cidr') throw new CmdError('INVALID', 'expected a single destination, not a CIDR range');
  if (t.kind === 'ip') return { input: dest, ip: dest, host: null };
  try { const r = await dns.lookup(dest, {}); return { input: dest, ip: r.address, host: dest }; }
  catch (e) { throw new CmdError('DNS', `cannot resolve '${dest}' (${e.code || e.message})`, { hints: ['Check the name and your DNS configuration (net dns).'] }); }
}

/** Multicast / broadcast entries the OS keeps in the neighbor table — not devices. */
const isNoiseNeighbor = n => /^ff:ff:ff:ff:ff:ff$/i.test(n.mac || '') || /^(01:00:5e|33:33)/i.test(n.mac || '') || /^(22[4-9]|23\d)\./.test(n.ip) || /^ff0/i.test(n.ip);

const primaryV6 = list => list.find(a => !/^fe80/i.test(a)) || list[0] || null;

/* ================================================================ routes / neighbors (platform back-ends) */

async function getRoutes(ctx, { ipv6 } = {}) {
  const signal = ctx.signal;
  if (platform.isLinux) {
    runner.need('ip', 'iproute2');
    const r = await runner.runChecked('ip', ['-j', ...(ipv6 ? ['-6'] : []), 'route', 'show'], { signal, timeoutMs: 8000 });
    return parseRoutesJson(JSON.parse(r.stdout || '[]'));
  }
  if (platform.isWindows) {
    const rows = await runner.psJson(
      `Get-NetRoute -AddressFamily ${ipv6 ? 'IPv6' : 'IPv4'} -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | ` +
      `ForEach-Object { [pscustomobject]@{ dst = $_.DestinationPrefix; gw = $_.NextHop; dev = $_.InterfaceAlias; metric = ($_.RouteMetric + $_.InterfaceMetric) } } | ConvertTo-Json -Compress`, { signal });
    const ifs = os.networkInterfaces();
    return rows.filter(r => !/^(ff00::|224\.|255\.255)/.test(r.dst)).map(r => {
      const v4 = (ifs[r.dev] || []).filter(a => a.family === 'IPv4');
      return {
        destination: /^(0\.0\.0\.0\/0|::\/0)$/.test(r.dst) ? 'default' : r.dst,
        gateway: /^(0\.0\.0\.0|::)$/.test(r.gw) ? 'direct' : r.gw,
        interface: r.dev, source: !ipv6 && v4.length === 1 ? v4[0].address : null, metric: r.metric, protocol: null, type: 'unicast',
      };
    });
  }
  throw unsupported('Routing table inspection', 'Use: netstat -rn');
}

async function getNeighbors(ctx) {
  const signal = ctx.signal;
  if (platform.isLinux) {
    runner.need('ip', 'iproute2');
    const r = await runner.runChecked('ip', ['-j', 'neigh', 'show'], { signal, timeoutMs: 8000 });
    return parseNeighJson(JSON.parse(r.stdout || '[]'));
  }
  if (platform.isWindows) {
    const rows = await runner.psJson(
      `Get-NetNeighbor -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ip = $_.IPAddress; mac = $_.LinkLayerAddress; dev = $_.InterfaceAlias; state = [string]$_.State } } | ConvertTo-Json -Compress`, { signal });
    return rows.filter(n => n.mac && !/^0{2}(-0{2}){5}$/.test(n.mac)).map(n => ({ ip: n.ip, mac: String(n.mac).replace(/-/g, ':').toLowerCase(), interface: n.dev, state: String(n.state).toUpperCase() }));
  }
  if (platform.isMac) {
    const r = await runner.runChecked('arp', ['-an'], { signal, timeoutMs: 8000 });
    return parseArpAn(r.stdout);
  }
  throw unsupported('Neighbor table inspection');
}

/** Which route/interface/source address would reach `ip`?  -> {destination, gateway, interface, source, metric} */
async function lookupRoute(ip, signal) {
  if (platform.isLinux) {
    runner.need('ip', 'iproute2');
    const r = await runner.run('ip', ['-j', 'route', 'get', ip], { signal, timeoutMs: 8000 });
    if (r.code !== 0) throw new CmdError(/unreachable/i.test(r.stderr) ? 'UNREACHABLE' : 'FAILED', `no route to ${ip}: ${(r.stderr || '').trim() || 'unreachable'}`);
    const [x] = parseRoutesJson(JSON.parse(r.stdout || '[]'));
    return { destination: ip, gateway: x.gateway === 'direct' || !x.gateway ? 'direct' : x.gateway, interface: x.interface, source: x.source, metric: x.metric };
  }
  if (platform.isWindows) {
    const rows = await runner.psJson(`Find-NetRoute -RemoteIPAddress $env:NETTERM_DEST -ErrorAction Stop | ConvertTo-Json -Compress -Depth 3`, { signal, env: { NETTERM_DEST: ip } });
    const route = rows.find(r => r.NextHop !== undefined), addr = rows.find(r => r.IPAddress !== undefined && r.PrefixLength !== undefined && r.NextHop === undefined);
    if (!route) throw new CmdError('UNREACHABLE', `no route to ${ip}`);
    return { destination: ip, gateway: /^(0\.0\.0\.0|::)$/.test(route.NextHop) ? 'direct' : route.NextHop, interface: route.InterfaceAlias, source: addr ? addr.IPAddress : null, metric: route.RouteMetric === undefined ? null : route.RouteMetric + (route.InterfaceMetric || 0) };
  }
  throw unsupported('Route lookup', 'Use: route -n get <destination>');
}

/* ================================================================ definitions */

const stateColor = (ctx, s) => /^(UP|REACHABLE|ESTABLISHED|PERMANENT)$/.test(s) ? ctx.style.ok(s) : /^(DOWN|FAILED|INCOMPLETE|UNREACHABLE)$/.test(s) ? ctx.style.err(s) : /^(STALE|DELAY|PROBE|LISTEN)$/.test(s) ? (s === 'LISTEN' ? ctx.style.cyan(s) : ctx.style.warn(s)) : s;

const defs = [
  {
    path: 'net interfaces',
    summary: 'Show network interfaces, addresses, link state and traffic counters',
    usage: 'net interfaces [name] [--json] [-v]',
    args: { min: 0, max: 1, names: ['interface'] },
    examples: ['net interfaces', 'net interfaces eth0 --json'],
    async run(ctx) {
      let list = await counters.listInterfaces({ signal: ctx.signal });
      if (ctx.args[0]) {
        const name = await counters.requireInterface(ctx.args[0], { signal: ctx.signal });
        list = list.filter(i => i.name === name);
        ctx.meta.target = name;
      }
      ctx.out.result({ interfaces: list }, data => {
        const s = ctx.style;
        const L = data.interfaces;
        ctx.out.table([
          { key: 'name', title: 'INTERFACE' }, { key: 'type', title: 'TYPE', format: v => v || 'N/A' },
          { key: 'state', title: 'STATE', color: t => stateColor(ctx, t) },
          { key: 'ipv4', title: 'IPV4', format: v => v.length ? v.join(', ') : 'N/A' },
          { key: 'ipv6', title: 'IPV6', format: v => v.length ? (ctx.verbose ? v.join(', ') : primaryV6(v)) : 'N/A' },
          { key: 'mac', title: 'MAC' }, { key: 'mtu', title: 'MTU', align: 'right' },
          { key: 'speedMbps', title: 'LINK SPEED', format: v => v ? `${fmtInt(v)} Mb/s` : 'N/A', align: 'right' },
        ], L);
        ctx.out.line('\n' + s.head('TRAFFIC COUNTERS') + s.dim('  (cumulative since boot / adapter reset)'));
        ctx.out.table([
          { key: 'name', title: 'INTERFACE' },
          { key: 'rx', title: 'RX BYTES', format: v => v.bytes === null ? 'N/A' : fmtBytes(v.bytes), align: 'right' },
          { key: 'tx', title: 'TX BYTES', format: v => v.bytes === null ? 'N/A' : fmtBytes(v.bytes), align: 'right' },
          { key: 'rx', title: 'RX PKTS', format: v => fmtInt(v.packets), align: 'right' },
          { key: 'tx', title: 'TX PKTS', format: v => fmtInt(v.packets), align: 'right' },
          { key: 'rx', title: 'RX ERR', format: v => fmtInt(v.errors), align: 'right', color: t => t !== 'N/A' && t !== '0' ? s.warn(t) : t },
          { key: 'tx', title: 'TX ERR', format: v => fmtInt(v.errors), align: 'right', color: t => t !== 'N/A' && t !== '0' ? s.warn(t) : t },
          { key: 'rx', title: 'RX DROP', format: v => fmtInt(v.dropped), align: 'right', color: t => t !== 'N/A' && t !== '0' ? s.warn(t) : t },
          { key: 'tx', title: 'TX DROP', format: v => fmtInt(v.dropped), align: 'right', color: t => t !== 'N/A' && t !== '0' ? s.warn(t) : t },
        ], L);
        ctx.out.info(s.dim('\nLINK SPEED is the negotiated capacity of the link, not measured throughput. Use `bandwidth client <host>` to measure.'));
      });
    },
  },

  {
    path: 'net routes',
    summary: 'Show the routing table',
    usage: 'net routes [--ipv6] [--json]',
    options: { ipv6: { type: 'bool', alias: '6', desc: 'show IPv6 routes' } },
    async run(ctx) {
      const routes = await getRoutes(ctx, { ipv6: ctx.opts.ipv6 });
      ctx.out.result({ routes }, d => ctx.out.table([
        { key: 'destination', title: 'DESTINATION' }, { key: 'gateway', title: 'GATEWAY' },
        { key: 'interface', title: 'INTERFACE' }, { key: 'source', title: 'SOURCE' }, { key: 'metric', title: 'METRIC', align: 'right' },
      ], d.routes));
    },
  },

  {
    path: 'route',
    summary: 'Show which route (and source address) would be used to reach a destination',
    usage: 'route <destination>',
    args: { min: 1, max: 1, names: ['destination'] },
    examples: ['route 192.168.1.20', 'route example.com'],
    async run(ctx) {
      const d = await resolveDestination(ctx.args[0], ctx.signal);
      ctx.meta.target = ctx.args[0];
      const info = await lookupRoute(d.ip, ctx.signal);
      const data = { ...info, resolvedFrom: d.host };
      ctx.out.result(data, v => ctx.out.table([
        { key: 'destination', title: 'DESTINATION' }, { key: 'gateway', title: 'GATEWAY' }, { key: 'interface', title: 'INTERFACE' }, { key: 'source', title: 'SOURCE' }, { key: 'metric', title: 'METRIC', align: 'right' },
      ], [v]));
    },
  },

  {
    path: 'net neighbors',
    summary: 'Show the ARP / neighbor table (devices recently seen on the LAN)',
    usage: 'net neighbors [--json] [-v]',
    async run(ctx) {
      let list = await getNeighbors(ctx);
      if (!ctx.verbose) list = list.filter(n => !/^(FAILED|INCOMPLETE)$/.test(n.state || '') && !isNoiseNeighbor(n));
      ctx.out.result({ neighbors: list }, d => {
        ctx.out.table([
          { key: 'ip', title: 'IP' }, { key: 'mac', title: 'MAC' }, { key: 'interface', title: 'INTERFACE' },
          { key: 'state', title: 'STATE', color: t => stateColor(ctx, t) },
        ], d.neighbors);
        ctx.out.info(ctx.style.dim('\nThis table only lists devices this host has talked to recently. For active discovery: scan --local --active'));
      });
    },
  },

  ...['connections', 'ports'].map(kind => ({
    path: `net ${kind}`,
    summary: kind === 'ports' ? 'Show listening ports and the processes that own them' : 'Show active connections',
    usage: `net ${kind} [--tcp] [--udp] [--listen] [--established] [--json]`,
    options: {
      tcp: { type: 'bool', desc: 'TCP only' }, udp: { type: 'bool', desc: 'UDP only' },
      listen: { type: 'bool', desc: 'listening sockets only' }, established: { type: 'bool', desc: 'established connections only' },
    },
    async run(ctx) {
      let rows;
      if (platform.isLinux) {
        runner.need('ss', 'iproute2');
        const flags = kind === 'ports' ? '-tulpn' : '-tunap';
        const r = await runner.runChecked('ss', [flags], { signal: ctx.signal, timeoutMs: 10000 });
        rows = parseSs(r.stdout);
      } else if (platform.isWindows) {
        const [ns, tl] = await Promise.all([
          runner.runChecked('netstat', ['-ano'], { signal: ctx.signal, timeoutMs: 15000 }),
          runner.run('tasklist', ['/FO', 'CSV', '/NH'], { signal: ctx.signal, timeoutMs: 15000 }),
        ]);
        rows = parseNetstatWin(ns.stdout, parseTasklist(tl.stdout));
      } else throw unsupported('Socket inspection', 'Use: lsof -nP -i');

      // `ports` = sockets that accept traffic (listening TCP, bound UDP); `connections` = everything
      if (kind === 'ports') rows = rows.filter(r => r.state === 'LISTEN' || (r.proto === 'UDP' && /\*$/.test(r.remote)));
      if (ctx.opts.tcp && !ctx.opts.udp) rows = rows.filter(r => r.proto === 'TCP');
      if (ctx.opts.udp && !ctx.opts.tcp) rows = rows.filter(r => r.proto === 'UDP');
      if (ctx.opts.listen) rows = rows.filter(r => r.state === 'LISTEN' || (r.proto === 'UDP' && /\*$/.test(r.remote)));
      if (ctx.opts.established) rows = rows.filter(r => r.state === 'ESTABLISHED');

      const hiddenProcs = !perms.isRoot() && platform.isLinux && rows.some(r => !r.process);
      ctx.out.result({ [kind]: rows, processInfo: hiddenProcs ? 'PERMISSION REQUIRED for sockets owned by other users' : 'complete' }, d => {
        ctx.out.table([
          { key: 'proto', title: 'PROTO' }, { key: 'local', title: 'LOCAL ADDRESS' }, { key: 'remote', title: 'REMOTE ADDRESS' },
          { key: 'state', title: 'STATE', color: t => stateColor(ctx, t) }, { key: 'process', title: 'PROCESS', format: v => v || '-' },
        ], d[kind]);
        if (hiddenProcs) ctx.out.info(ctx.style.dim('\nPROCESS: PERMISSION REQUIRED to see processes owned by other users (run with sudo).'));
      });
    },
  })),

  {
    path: 'net dns',
    summary: 'Show the DNS configuration this host uses',
    usage: 'net dns [--json]',
    async run(ctx) {
      const servers = dns.getServers();
      let search = [], options = [], perInterface = [], resolverNote = null;
      if (platform.isUnix) {
        try {
          const rc = fs.readFileSync('/etc/resolv.conf', 'utf8');
          for (const l of rc.split('\n')) {
            const [k, ...v] = l.trim().split(/\s+/);
            if (k === 'search' || k === 'domain') search.push(...v);
            if (k === 'options') options.push(...v);
          }
          if (/^127\.0\.0\.(53|54)$/.test(servers[0] || '')) resolverNote = 'systemd-resolved stub resolver; upstream servers below';
        } catch { /* no resolv.conf */ }
        if (resolverNote && platform.isLinux && runner.has('resolvectl')) {
          const r = await runner.run('resolvectl', ['dns'], { signal: ctx.signal, timeoutMs: 5000 });
          perInterface = parseResolvectlDns(r.stdout);
        }
      } else if (platform.isWindows) {
        const rows = await runner.psJson(`Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { [pscustomobject]@{ interface = $_.InterfaceAlias; family = [string]$_.AddressFamily; servers = @($_.ServerAddresses) } } | ConvertTo-Json -Compress -Depth 3`, { signal: ctx.signal });
        perInterface = rows.filter(r => /^(2|IPv4|InterNetwork)$/.test(r.family) || ctx.verbose).map(r => ({ interface: r.interface, servers: [].concat(r.servers) }));
        const sfx = await runner.psJson(`ConvertTo-Json -Compress -InputObject @((Get-DnsClientGlobalSetting).SuffixSearchList)`, { signal: ctx.signal }).catch(() => []);
        search = sfx.filter(x => typeof x === 'string');
      }
      ctx.out.result({ servers, searchDomains: search, options, perInterface, note: resolverNote }, d => {
        ctx.out.kv([
          ['NAMESERVERS', d.servers.length ? d.servers.join(', ') : 'N/A'],
          ['SEARCH DOMAINS', d.searchDomains.length ? d.searchDomains.join(', ') : 'N/A'],
          ...(d.options.length ? [['OPTIONS', d.options.join(' ')]] : []),
        ]);
        if (d.note) ctx.out.line(ctx.style.dim(`\n${d.note}`));
        if (d.perInterface.length) {
          ctx.out.line('\n' + ctx.style.head('PER INTERFACE'));
          ctx.out.table([{ key: 'interface', title: 'INTERFACE' }, { key: 'servers', title: 'SERVERS', format: v => v.join(', ') }], d.perInterface);
        }
        ctx.out.info(ctx.style.dim('\nTest resolution with: resolve <domain>'));
      });
    },
  },

  {
    path: 'net stats',
    summary: 'Protocol statistics: IP, TCP (retransmits), UDP, ICMP',
    usage: 'net stats [--json]',
    async run(ctx) {
      if (!platform.isLinux) throw unsupported('Protocol statistics (they come from /proc/net/snmp)', 'Per-interface counters are available with: net interfaces');
      let snmp;
      try { snmp = parseSnmp(fs.readFileSync('/proc/net/snmp', 'utf8')); }
      catch { throw new CmdError('UNAVAILABLE', '/proc/net/snmp is not readable on this system'); }
      const tcp = snmp.Tcp || {}, udp = snmp.Udp || {}, ip = snmp.Ip || {}, icmp = snmp.Icmp || {};
      const data = {
        ip: { inReceives: ip.InReceives, inDiscards: ip.InDiscards, inHdrErrors: ip.InHdrErrors, outRequests: ip.OutRequests, outDiscards: ip.OutDiscards, reasmFails: ip.ReasmFails, fragFails: ip.FragFails },
        tcp: { currEstab: tcp.CurrEstab, activeOpens: tcp.ActiveOpens, passiveOpens: tcp.PassiveOpens, attemptFails: tcp.AttemptFails, estabResets: tcp.EstabResets, inSegs: tcp.InSegs, outSegs: tcp.OutSegs, retransSegs: tcp.RetransSegs, inErrs: tcp.InErrs, retransPercent: tcp.OutSegs ? (tcp.RetransSegs / tcp.OutSegs) * 100 : null },
        udp: { inDatagrams: udp.InDatagrams, outDatagrams: udp.OutDatagrams, noPorts: udp.NoPorts, inErrors: udp.InErrors, rcvbufErrors: udp.RcvbufErrors, sndbufErrors: udp.SndbufErrors },
        icmp: { inMsgs: icmp.InMsgs, outMsgs: icmp.OutMsgs, inDestUnreachs: icmp.InDestUnreachs, outDestUnreachs: icmp.OutDestUnreachs },
      };
      ctx.out.result(data, d => {
        const s = ctx.style, bad = (v, label) => (v > 0 ? s.warn(fmtInt(v)) : fmtInt(v));
        ctx.out.line(s.head('IP'));
        ctx.out.kv([['received', fmtInt(d.ip.inReceives)], ['sent', fmtInt(d.ip.outRequests)], ['discarded in/out', `${bad(d.ip.inDiscards)} / ${bad(d.ip.outDiscards)}`], ['header errors', bad(d.ip.inHdrErrors)], ['reassembly/fragment fails', `${bad(d.ip.reasmFails)} / ${bad(d.ip.fragFails)}`]]);
        ctx.out.line('\n' + s.head('TCP'));
        ctx.out.kv([['established now', fmtInt(d.tcp.currEstab)], ['active / passive opens', `${fmtInt(d.tcp.activeOpens)} / ${fmtInt(d.tcp.passiveOpens)}`], ['segments in / out', `${fmtInt(d.tcp.inSegs)} / ${fmtInt(d.tcp.outSegs)}`],
          ['retransmitted', `${bad(d.tcp.retransSegs)}${d.tcp.retransPercent !== null ? s.dim(`  (${d.tcp.retransPercent.toFixed(2)}% of segments sent)`) : ''}`], ['failed attempts / resets', `${bad(d.tcp.attemptFails)} / ${bad(d.tcp.estabResets)}`], ['input errors', bad(d.tcp.inErrs)]]);
        ctx.out.line('\n' + s.head('UDP'));
        ctx.out.kv([['datagrams in / out', `${fmtInt(d.udp.inDatagrams)} / ${fmtInt(d.udp.outDatagrams)}`], ['no listener', bad(d.udp.noPorts)], ['input errors', bad(d.udp.inErrors)], ['buffer errors rx / tx', `${bad(d.udp.rcvbufErrors)} / ${bad(d.udp.sndbufErrors)}`]]);
        ctx.out.info(s.dim('\nRising UDP buffer errors usually mean a receiver (camera/telemetry) cannot keep up; rising TCP retransmits point at a lossy link.'));
      });
    },
  },
];

module.exports = Object.assign(defs, {
  parsers: { parseRoutesJson, parseNeighJson, parseArpAn, parseSs, parseNetstatWin, parseTasklist, parseSnmp, parseResolvectlDns },
  getNeighbors, getRoutes, resolveDestination, lookupRoute, isNoiseNeighbor,
});
