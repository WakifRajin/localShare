'use strict';
/**
 * Interface inventory and live counters — taken from the operating system, never synthesised.
 *  Linux:   `ip -j addr` + `ip -j -s -d link` (machine-readable JSON) and /sys/class/net
 *  Windows: PowerShell Get-NetAdapter / Get-NetAdapterStatistics (JSON) + Node's os API
 *  macOS:   Node's os API + `netstat -ib`
 * Anything the platform cannot tell us is null (rendered as N/A), not guessed.
 */
const os = require('os');
const fs = require('fs');
const runner = require('../system/command_runner');
const platform = require('../system/platform');
const { CmdError } = require('../errors');

const readSys = (name, file) => { try { return fs.readFileSync(`/sys/class/net/${name}/${file}`, 'utf8').trim(); } catch { return null; } };
const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

/* ---------------------------------------------------------------- Linux */

function normState(operstate, flags = []) {
  if (operstate === 'UP') return 'UP';
  if (operstate === 'DOWN' || operstate === 'LOWERLAYERDOWN' || operstate === 'NOTPRESENT') return 'DOWN';
  if (flags.includes('NO-CARRIER')) return 'DOWN';
  if (flags.includes('LOWER_UP') || (flags.includes('UP') && operstate === 'UNKNOWN')) return 'UP';
  return flags.includes('UP') ? 'UP' : 'DOWN';
}

function ifaceType(a, kind) {
  if (a.link_type === 'loopback') return 'loopback';
  if (kind && kind !== 'none') return kind;                          // veth, bridge, vlan, tun, bond, wireguard, ...
  if (a.link_type === 'ether') return fs.existsSync(`/sys/class/net/${a.ifname}/wireless`) ? 'wifi' : 'ethernet';
  return a.link_type || null;
}

/** Combine `ip -j addr` and `ip -j -s -d link` output. Pure — unit-tested with captured samples. */
function parseIpJson(addrJson, linkJson, { sys = readSys } = {}) {
  const extra = new Map();
  for (const l of linkJson || []) extra.set(l.ifname, l);
  return (addrJson || []).map(a => {
    const l = extra.get(a.ifname) || {};
    const st = l.stats64 || l.stats || null;
    const info = (a.addr_info || []);
    const speed = num(sys(a.ifname, 'speed'));
    return {
      name: a.ifname,
      type: ifaceType(a, l.linkinfo && l.linkinfo.info_kind),
      state: normState(a.operstate, a.flags),
      ipv4: info.filter(i => i.family === 'inet').map(i => `${i.local}/${i.prefixlen}`),
      ipv6: info.filter(i => i.family === 'inet6').map(i => `${i.local}/${i.prefixlen}`),
      mac: a.link_type === 'loopback' ? null : (a.address || null),
      mtu: num(a.mtu),
      speedMbps: speed !== null && speed > 0 ? speed : null,
      rx: st ? { bytes: num(st.rx.bytes), packets: num(st.rx.packets), errors: num(st.rx.errors), dropped: num(st.rx.dropped) } : nullCounters(),
      tx: st ? { bytes: num(st.tx.bytes), packets: num(st.tx.packets), errors: num(st.tx.errors), dropped: num(st.tx.dropped) } : nullCounters(),
    };
  });
}
const nullCounters = () => ({ bytes: null, packets: null, errors: null, dropped: null });

async function linuxInterfaces(signal) {
  if (runner.has('ip')) {
    try {
      const [a, l] = await Promise.all([
        runner.runChecked('ip', ['-j', 'addr'], { signal, timeoutMs: 8000 }),
        runner.runChecked('ip', ['-j', '-s', '-d', 'link'], { signal, timeoutMs: 8000 }),
      ]);
      return parseIpJson(JSON.parse(a.stdout || '[]'), JSON.parse(l.stdout || '[]'));
    } catch (e) {
      if (e.code === 'CANCELLED') throw e;
      /* very old iproute2 without -j: fall through to the sysfs view */
    }
  }
  return sysfsInterfaces();
}

/** Fallback when `ip` is unavailable: Node's os API + /sys. */
function sysfsInterfaces() {
  const osIf = os.networkInterfaces();
  let names = Object.keys(osIf);
  try { names = [...new Set([...fs.readdirSync('/sys/class/net'), ...names])]; } catch { /* not linux */ }
  return names.sort().map(name => {
    const addrs = osIf[name] || [];
    const speed = num(readSys(name, 'speed'));
    const c = f => num(readSys(name, `statistics/${f}`));
    return {
      name,
      type: name === 'lo' ? 'loopback' : fs.existsSync(`/sys/class/net/${name}/wireless`) ? 'wifi' : readSys(name, 'type') === '1' ? 'ethernet' : null,
      state: normState((readSys(name, 'operstate') || '').toUpperCase(), []),
      ipv4: addrs.filter(a => a.family === 'IPv4').map(a => a.cidr || a.address),
      ipv6: addrs.filter(a => a.family === 'IPv6').map(a => a.cidr || a.address),
      mac: name === 'lo' ? null : (readSys(name, 'address') || (addrs[0] && addrs[0].mac !== '00:00:00:00:00:00' ? addrs[0].mac : null)),
      mtu: num(readSys(name, 'mtu')),
      speedMbps: speed !== null && speed > 0 ? speed : null,
      rx: { bytes: c('rx_bytes'), packets: c('rx_packets'), errors: c('rx_errors'), dropped: c('rx_dropped') },
      tx: { bytes: c('tx_bytes'), packets: c('tx_packets'), errors: c('tx_errors'), dropped: c('tx_dropped') },
    };
  });
}

/* ---------------------------------------------------------------- Windows */

const PS_ADAPTERS = `
$ErrorActionPreference = 'SilentlyContinue'
$stats = @{}
Get-NetAdapterStatistics | ForEach-Object { $stats[$_.Name] = $_ }
$list = @(Get-NetAdapter | ForEach-Object {
  $s = $stats[$_.Name]
  [pscustomobject]@{
    name = $_.Name; status = [string]$_.Status; mac = $_.MacAddress; mtu = $_.MtuSize; speedBps = $_.Speed
    media = [string]$_.PhysicalMediaType; desc = $_.InterfaceDescription; fullDuplex = $_.FullDuplex
    rxBytes = $s.ReceivedBytes; txBytes = $s.SentBytes
    rxPackets = ($s.ReceivedUnicastPackets + $s.ReceivedMulticastPackets + $s.ReceivedBroadcastPackets)
    txPackets = ($s.SentUnicastPackets + $s.SentMulticastPackets + $s.SentBroadcastPackets)
    rxErrors = $s.ReceivedPacketErrors; txErrors = $s.OutboundPacketErrors
    rxDropped = $s.ReceivedDiscardedPackets; txDropped = $s.OutboundDiscardedPackets
  }
})
ConvertTo-Json -Compress -InputObject $list`;

function winType(a) {
  const m = `${a.media || ''} ${a.desc || ''}`.toLowerCase();
  if (/loopback/.test(m)) return 'loopback';
  if (/802\.3|ethernet/.test(m) && !/virtual|vethernet|hyper-v|vmware|virtualbox/.test(m)) return 'ethernet';
  if (/wireless|wi-?fi|802\.11/.test(m)) return 'wifi';
  if (/virtual|vethernet|hyper-v|vmware|virtualbox/.test(m)) return 'virtual';
  return a.media && a.media !== 'Unspecified' ? a.media.toLowerCase() : null;
}

async function windowsInterfaces(signal) {
  const osIf = os.networkInterfaces();
  let adapters = [];
  try {
    const r = await runner.powershell(PS_ADAPTERS, { signal });
    const txt = r.stdout.trim();
    if (txt) { const j = JSON.parse(txt); adapters = Array.isArray(j) ? j : [j]; }
  } catch (e) { if (e.code === 'CANCELLED') throw e; }
  const seen = new Set();
  const out = adapters.map(a => {
    seen.add(a.name);
    const addrs = osIf[a.name] || [];
    return {
      name: a.name, type: winType(a),
      state: /^up$/i.test(a.status) ? 'UP' : /disconnected|disabled|not present|down/i.test(a.status) ? 'DOWN' : 'UNKNOWN',
      ipv4: addrs.filter(x => x.family === 'IPv4').map(x => x.cidr || x.address),
      ipv6: addrs.filter(x => x.family === 'IPv6').map(x => x.cidr || x.address),
      mac: a.mac ? String(a.mac).replace(/-/g, ':').toLowerCase() : null,
      mtu: num(a.mtu),
      speedMbps: num(a.speedBps) > 0 && num(a.speedBps) < 1e15 ? Math.round(num(a.speedBps) / 1e6) : null,
      rx: { bytes: num(a.rxBytes), packets: num(a.rxPackets), errors: num(a.rxErrors), dropped: num(a.rxDropped) },
      tx: { bytes: num(a.txBytes), packets: num(a.txPackets), errors: num(a.txErrors), dropped: num(a.txDropped) },
    };
  });
  // Interfaces Node knows about but PowerShell didn't report (e.g. the loopback pseudo-interface).
  for (const [name, addrs] of Object.entries(osIf)) {
    if (seen.has(name)) continue;
    out.push({
      name, type: addrs.some(a => a.internal) ? 'loopback' : null, state: 'UP',
      ipv4: addrs.filter(x => x.family === 'IPv4').map(x => x.cidr || x.address),
      ipv6: addrs.filter(x => x.family === 'IPv6').map(x => x.cidr || x.address),
      mac: null, mtu: null, speedMbps: null, rx: nullCounters(), tx: nullCounters(),
    });
  }
  return out;
}

/* ---------------------------------------------------------------- macOS / other */

function otherInterfaces() {
  return Object.entries(os.networkInterfaces()).map(([name, addrs]) => ({
    name, type: addrs.some(a => a.internal) ? 'loopback' : null, state: addrs.length ? 'UP' : 'UNKNOWN',
    ipv4: addrs.filter(x => x.family === 'IPv4').map(x => x.cidr || x.address),
    ipv6: addrs.filter(x => x.family === 'IPv6').map(x => x.cidr || x.address),
    mac: addrs[0] && addrs[0].mac !== '00:00:00:00:00:00' ? addrs[0].mac : null,
    mtu: null, speedMbps: null, rx: nullCounters(), tx: nullCounters(),
  }));
}

/** @returns {Promise<Array>} normalised interface records */
async function listInterfaces({ signal } = {}) {
  if (platform.isLinux) return linuxInterfaces(signal);
  if (platform.isWindows) return windowsInterfaces(signal);
  return otherInterfaces();
}

async function interfaceNames(opts) {
  try { return (await listInterfaces(opts)).map(i => i.name); } catch { return Object.keys(os.networkInterfaces()); }
}

/** Throws a helpful NOT_FOUND error (with the list of real interfaces) if `name` doesn't exist. */
async function requireInterface(name, opts) {
  const names = await interfaceNames(opts);
  if (names.includes(name)) return name;
  const ci = names.find(n => n.toLowerCase() === String(name).toLowerCase());
  if (ci) return ci;
  throw new CmdError('NOT_FOUND', `interface '${name}' does not exist.`, { hints: ['Available interfaces:', ...names.map(n => `  ${n}`)] });
}

/* ---------------------------------------------------------------- live counters */

const SYS_FILES = { rxBytes: 'rx_bytes', txBytes: 'tx_bytes', rxPackets: 'rx_packets', txPackets: 'tx_packets', rxErrors: 'rx_errors', txErrors: 'tx_errors', rxDropped: 'rx_dropped', txDropped: 'tx_dropped' };

const PS_COUNTERS = `
$ErrorActionPreference = 'SilentlyContinue'
$s = Get-NetAdapterStatistics -Name $env:NETTERM_IF
if (-not $s) { exit 3 }
[pscustomobject]@{
  rxBytes = $s.ReceivedBytes; txBytes = $s.SentBytes
  rxPackets = ($s.ReceivedUnicastPackets + $s.ReceivedMulticastPackets + $s.ReceivedBroadcastPackets)
  txPackets = ($s.SentUnicastPackets + $s.SentMulticastPackets + $s.SentBroadcastPackets)
  rxErrors = $s.ReceivedPacketErrors; txErrors = $s.OutboundPacketErrors
  rxDropped = $s.ReceivedDiscardedPackets; txDropped = $s.OutboundDiscardedPackets
} | ConvertTo-Json -Compress`;

/** One cumulative-counter sample for an interface. Linux reads sysfs (microseconds); others call out. */
async function sampleCounters(name, { signal } = {}) {
  const t = Date.now();
  if (platform.isLinux) {
    const o = { t };
    for (const [k, f] of Object.entries(SYS_FILES)) o[k] = num(readSys(name, `statistics/${f}`));
    if (o.rxBytes === null) throw new CmdError('UNAVAILABLE', `no counters for '${name}' in /sys/class/net`);
    return o;
  }
  if (platform.isWindows) {
    const r = await runner.powershell(PS_COUNTERS, { signal, env: { NETTERM_IF: name } });
    if (!r.stdout.trim()) throw new CmdError('NOT_FOUND', `interface '${name}' has no statistics`);
    const j = JSON.parse(r.stdout);
    const o = { t };
    for (const k of Object.keys(SYS_FILES)) o[k] = num(j[k]);
    return o;
  }
  if (platform.isMac) {
    const r = await runner.runChecked('netstat', ['-ib', '-I', name], { signal });
    const lines = r.stdout.trim().split('\n');
    const row = lines.slice(1).map(l => l.trim().split(/\s+/)).find(c => /^<Link/.test(c[2]));
    if (!row) throw new CmdError('UNAVAILABLE', `no counters for '${name}'`);
    const n = row.length;
    // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    return { t, rxPackets: num(row[n - 7]), rxErrors: num(row[n - 6]), rxBytes: num(row[n - 5]), txPackets: num(row[n - 4]), txErrors: num(row[n - 3]), txBytes: num(row[n - 2]), rxDropped: null, txDropped: null };
  }
  throw new CmdError('UNSUPPORTED_PLATFORM', `interface counters are not supported on ${platform.label()}`);
}

/** Negotiated link speed in Mb/s, or null. (Capacity of the link — NOT a throughput measurement.) */
async function linkSpeedMbps(name, opts) {
  if (platform.isLinux) { const v = num(readSys(name, 'speed')); return v > 0 ? v : null; }
  try { const i = (await listInterfaces(opts)).find(x => x.name === name); return i ? i.speedMbps : null; } catch { return null; }
}

/** The interface carrying the default route (what most traffic uses), or null. */
async function defaultInterface({ signal } = {}) {
  try {
    if (platform.isLinux && runner.has('ip')) {
      const r = await runner.run('ip', ['-j', 'route', 'show', 'default'], { signal, timeoutMs: 5000 });
      const routes = JSON.parse(r.stdout || '[]').sort((a, b) => (a.metric || 0) - (b.metric || 0));
      return routes[0] ? routes[0].dev : null;
    }
    if (platform.isWindows) {
      const r = await runner.powershell(`(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1).InterfaceAlias`, { signal });
      return r.stdout.trim() || null;
    }
  } catch { /* fall through */ }
  return null;
}

module.exports = { listInterfaces, interfaceNames, requireInterface, sampleCounters, linkSpeedMbps, defaultInterface, parseIpJson, normState, readSys };
