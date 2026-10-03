'use strict';
/** bandwidth server | client | udp   and   monitor bandwidth */
const os = require('os');
const runner = require('../system/command_runner');
const counters = require('../monitoring/counters');
const network = require('./network');
const config = require('../config');
const { CmdError } = require('../errors');
const V = require('../system/validate');
const { fmtBytes, fmtRate, fmtMs, fmtInt, fmtPct, bar } = require('../output/terminal');

const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
  if (signal) { if (signal.aborted) return done(); signal.addEventListener('abort', done, { once: true }); }
});

/* ================================================================ parsers (pure) */

/** iperf3 -J output -> normalised result. Throws CmdError on a reported error. */
function parseIperf(json) {
  if (!json || typeof json !== 'object') throw new CmdError('FAILED', 'iperf3 produced no usable output.');
  if (json.error) {
    const msg = String(json.error);
    if (/refused/i.test(msg)) throw new CmdError('UNREACHABLE', 'connection refused — no iperf3 server is listening there.', { hints: ['Start one on the target with: bandwidth server', 'Check the port (--port) and any firewall between the hosts.'] });
    if (/timed? ?out/i.test(msg)) throw new CmdError('TIMEOUT', 'connection to the iperf3 server timed out.', { hints: ['The host may be down or the port filtered.'] });
    if (/busy/i.test(msg)) throw new CmdError('FAILED', 'the server is busy with another test — try again in a few seconds.');
    throw new CmdError('FAILED', `iperf3: ${msg}`);
  }
  const ts = (json.start && json.start.test_start) || {};
  const end = json.end || {};
  const udp = ts.protocol === 'UDP';
  const sent = end.sum_sent || null, recv = end.sum_received || null, sum = end.sum || null;
  const r = {
    protocol: ts.protocol || (udp ? 'UDP' : 'TCP'), durationSec: ts.duration ?? null, streams: ts.num_streams ?? null, reverse: !!ts.reverse,
    blockSizeBytes: ts.blksize ?? null, targetBitrate: ts.target_bitrate || null,
  };
  if (udp) {
    const u = sum || recv || sent || {};
    Object.assign(r, { transferBytes: u.bytes ?? null, bitsPerSecond: u.bits_per_second ?? null, jitterMs: u.jitter_ms ?? null, lostPackets: u.lost_packets ?? null, packets: u.packets ?? null, lossPercent: u.lost_percent ?? null });
  } else {
    Object.assign(r, {
      transferBytes: (recv || sent || {}).bytes ?? null,
      sender: sent ? { bytes: sent.bytes, bitsPerSecond: sent.bits_per_second, retransmits: sent.retransmits ?? null } : null,
      receiver: recv ? { bytes: recv.bytes, bitsPerSecond: recv.bits_per_second } : null,
      retransmits: sent && sent.retransmits !== undefined ? sent.retransmits : null,
    });
  }
  if (r.bitsPerSecond === undefined && !udp) r.bitsPerSecond = r.receiver ? r.receiver.bitsPerSecond : (r.sender ? r.sender.bitsPerSecond : null);
  return r;
}

const RATE_RE = /^\d+(\.\d+)?[KMGkmg]?$/;

/** Mb/s of the link used to reach `ip` (negotiated capacity — never presented as throughput) */
async function localLinkFor(ip, signal) {
  try {
    const route = await network.lookupRoute(ip, signal);
    return { interface: route.interface, speedMbps: route.interface ? await counters.linkSpeedMbps(route.interface, { signal }) : null };
  } catch { return { interface: null, speedMbps: null }; }
}

const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

/* ================================================================ iperf3 runs */

function iperfArgs(ctx, host, { udp }) {
  const o = ctx.opts;
  const duration = V.parseNumber(o.duration ?? 10, 'duration', { min: 1, max: 600, int: true });
  const streams = V.parseNumber(o.streams ?? 1, 'streams', { min: 1, max: 128, int: true });
  const port = o.port === undefined ? 5201 : V.parsePort(o.port);
  const args = ['-c', host, '-p', port, '-t', duration, '-P', streams, '-J'];
  if (o.reverse) args.push('-R');
  if (udp) {
    const rate = String(o.rate ?? '100M');
    if (!RATE_RE.test(rate)) throw new CmdError('INVALID', `invalid rate '${rate}'`, { hints: ['Examples: 50M, 1G, 800K'] });
    args.push('-u', '-b', rate);
    if (o.length !== undefined) args.push('-l', V.parseNumber(o.length, 'length', { min: 16, max: 65507, int: true }));
  }
  return { args, duration, streams, port };
}

async function runClient(ctx, udp) {
  const host = ctx.args[0];
  const t = V.parseTarget(host);
  if (t.kind === 'cidr') throw new CmdError('INVALID', 'expected a single host, not a range');
  runner.need('iperf3', 'required for bandwidth tests');
  ctx.meta.target = host;
  const { args, duration, streams, port } = iperfArgs(ctx, host, { udp });

  ctx.out.info(`${ctx.style.head('NETWORK THROUGHPUT TEST')}  ${ctx.style.dim(`${udp ? 'UDP' : 'TCP'} · ${host}:${port} · ${duration} s`)}\n`);
  const started = Date.now();
  const tick = setInterval(() => ctx.out.frame(`${ctx.style.dim('running')} ${Math.min(duration, Math.round((Date.now() - started) / 1000))}/${duration} s`), 500);
  let r;
  try { r = await runner.run('iperf3', args, { signal: ctx.signal, timeoutMs: (duration + 25) * 1000 }); }
  finally { clearInterval(tick); }
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
  if (r.timedOut) throw new CmdError('TIMEOUT', 'the test did not finish in time.');

  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* fall through to stderr */ }
  if (!json) {
    const e = (r.stderr || r.stdout || '').trim().split('\n')[0];
    if (/unknown host|could not resolve|name or service not known|nodename nor servname/i.test(e)) throw new CmdError('DNS', `cannot resolve '${host}' (name not found).`);
    if (/unrecognized option|invalid option/i.test(e)) throw new CmdError('FAILED', `this iperf3 version rejected an option: ${e}`);
    throw new CmdError('FAILED', e || `iperf3 exited with code ${r.code}`);
  }
  const res = parseIperf(json);
  const ip = t.kind === 'ip' ? host : null;
  const link = await localLinkFor(ip || host, ctx.signal);
  const data = { target: host, port, ...res, link: { interface: link.interface, negotiatedMbps: link.speedMbps, note: 'negotiated link capacity — not a measurement' } };

  ctx.out.result(data, d => {
    const s = ctx.style;
    ctx.out.line();
    ctx.out.kv([['Target:', d.target], ['Protocol:', d.protocol], ['Duration:', `${d.durationSec ?? duration} s`], ['Streams:', d.streams ?? streams], ['Direction:', d.reverse ? 'server → this host (reverse)' : 'this host → server']], { labelWidth: 14 });
    ctx.out.line();
    if (d.protocol === 'UDP') {
      ctx.out.kv([['TRANSFER', fmtBytes(d.transferBytes)], ['BANDWIDTH', s.bold(fmtRate(d.bitsPerSecond))], ['JITTER', d.jitterMs === null ? 'N/A' : fmtMs(d.jitterMs)],
        ['PACKET LOSS', d.lossPercent === null ? 'N/A' : (d.lossPercent > 0.5 ? s.warn : s.ok)(`${d.lossPercent.toFixed(2)}%`) + s.dim(`  (${fmtInt(d.lostPackets)} of ${fmtInt(d.packets)} datagrams)`)]], { labelWidth: 16 });
    } else {
      ctx.out.kv([
        ['TRANSFER', fmtBytes(d.transferBytes)],
        ['THROUGHPUT', s.bold(fmtRate(d.bitsPerSecond)) + s.dim('  measured by iperf3')],
        ...(d.sender && d.receiver ? [['  sender', fmtRate(d.sender.bitsPerSecond)], ['  receiver', fmtRate(d.receiver.bitsPerSecond)]] : []),
        ['RETRANSMITS', d.retransmits === null ? 'N/A' : (d.retransmits > 0 ? s.warn(fmtInt(d.retransmits)) : s.ok('0'))],
        ['JITTER', '-'], ['PACKET LOSS', '-'],
      ], { labelWidth: 16 });
    }
    ctx.out.line();
    ctx.out.kv([['LINK SPEED', d.link.negotiatedMbps ? `${fmtInt(d.link.negotiatedMbps)} Mb/s${d.link.interface ? s.dim(`  (${d.link.interface}, negotiated)`) : ''}` : 'N/A']], { labelWidth: 16 });
    ctx.out.info(s.dim(
      '\nLINK SPEED  capacity the interface negotiated with its switch — an upper bound, not a measurement.' +
      '\nTHROUGHPUT  application-layer payload rate iperf3 observed (excludes Ethernet/IP/TCP headers, so it sits a few % below line rate).'));
    if (d.link.negotiatedMbps && d.bitsPerSecond && d.protocol === 'TCP' && d.bitsPerSecond / 1e6 < d.link.negotiatedMbps * 0.5)
      ctx.out.info(s.warn(`\nMeasured throughput is under half of the ${fmtInt(d.link.negotiatedMbps)} Mb/s link speed — try --streams 4, check CPU load on both ends, and the path beyond the first switch.`));
  });
}

async function runServer(ctx) {
  if (ctx.json) throw new CmdError('INVALID', 'server mode streams text and has no JSON form.');
  runner.need('iperf3', 'required for bandwidth tests');
  const port = ctx.opts.port === undefined ? 5201 : V.parsePort(ctx.opts.port);
  ctx.meta.target = `port ${port}`;
  const s = ctx.style;
  ctx.out.line(`${s.head('IPERF3 SERVER')}  ${s.dim(`listening on TCP/UDP ${port}`)}\n`);
  const addrs = lanAddresses();
  ctx.out.line(addrs.length ? `From another machine run:\n${addrs.map(a => `  bandwidth client ${a}${port !== 5201 ? ' --port ' + port : ''}`).join('\n')}` : s.dim('No non-loopback IPv4 address found on this host.'));
  ctx.out.line(s.dim('\nPress Ctrl+C to stop.\n'));
  const args = ['-s', '-p', port, ...(ctx.opts['one-off'] ? ['-1'] : [])];
  const r = await runner.run('iperf3', args, { signal: ctx.signal, onLine: l => ctx.out.line(s.dim(l)), onErrLine: l => ctx.out.line(s.warn(l)) });
  if (r.aborted) { ctx.out.line(s.dim('\nServer stopped.')); return; }
  if (r.code !== 0) throw new CmdError('FAILED', (r.stderr.trim().split('\n')[0] || 'iperf3 server exited') + (/in use/i.test(r.stderr) ? '' : ''), /in use/i.test(r.stderr) ? { hints: [`Port ${port} is already in use — is another iperf3 server running? Use --port to pick another.`] } : {});
}

/* ================================================================ live monitor */

async function runMonitor(ctx) {
  const o = ctx.opts;
  const interval = V.parseNumber(o.interval ?? config.defaults.monitorIntervalSec, 'interval', { min: 0.2, max: 60 });
  const maxSamples = o.count === undefined ? Infinity : V.parseNumber(o.count, 'count', { min: 1, max: 1e6, int: true });
  let name = ctx.args[0];
  if (name) name = await counters.requireInterface(V.validIface(name), { signal: ctx.signal });
  else {
    name = await counters.defaultInterface({ signal: ctx.signal });
    if (!name) {
      const up = (await counters.listInterfaces({ signal: ctx.signal })).filter(i => i.state === 'UP' && i.type !== 'loopback' && i.rx.bytes !== null);
      name = up.sort((a, b) => (b.rx.bytes + b.tx.bytes) - (a.rx.bytes + a.tx.bytes))[0]?.name;
    }
    if (!name) throw new CmdError('NOT_FOUND', 'could not pick an interface automatically.', { hints: ['Name one: monitor bandwidth <interface>', 'List them with: net interfaces'] });
  }
  ctx.meta.target = name;
  const linkMbps = await counters.linkSpeedMbps(name, { signal: ctx.signal });
  const s = ctx.style;
  let prev = await counters.sampleCounters(name, { signal: ctx.signal });
  let peak = 1e6, n = 0;

  while (!ctx.signal.aborted && n < maxSamples) {
    await sleep(interval * 1000, ctx.signal);
    if (ctx.signal.aborted) break;
    const cur = await counters.sampleCounters(name, { signal: ctx.signal });
    const dt = (cur.t - prev.t) / 1000;
    const rate = (a, b) => (a === null || b === null || dt <= 0) ? null : Math.max(0, ((a - b) * 8) / dt);   // counter wrap/reset clamps to 0
    const rx = rate(cur.rxBytes, prev.rxBytes), tx = rate(cur.txBytes, prev.txBytes);
    prev = cur; n++;
    peak = Math.max(peak, rx || 0, tx || 0);
    const scale = linkMbps ? linkMbps * 1e6 : peak;

    if (ctx.json) {
      ctx.out.jsonLine({ interface: name, timestamp: new Date(cur.t).toISOString(), rxBitsPerSecond: rx, txBitsPerSecond: tx, totals: { rxBytes: cur.rxBytes, txBytes: cur.txBytes, rxPackets: cur.rxPackets, txPackets: cur.txPackets, rxErrors: cur.rxErrors, txErrors: cur.txErrors, rxDropped: cur.rxDropped, txDropped: cur.txDropped }, linkMbps });
      continue;
    }
    const line = (label, v) => `${s.label(label)}\n${bar(s, v === null ? 0 : v / scale)}  ${v === null ? 'N/A' : fmtRate(v)}`;
    ctx.out.frame([
      `${s.head('INTERFACE:')} ${name}   ${s.dim(linkMbps ? `link ${fmtInt(linkMbps)} Mb/s · bars scaled to link speed` : 'link speed N/A · bars scaled to the peak seen')}`,
      '', line('RX', rx), '', line('TX', tx), '',
      `${s.label('TOTAL RX')}  ${fmtBytes(cur.rxBytes)}    ${s.label('TOTAL TX')}  ${fmtBytes(cur.txBytes)}   ${s.dim('(since boot / adapter reset)')}`,
      '', s.label('PACKETS'), `RX  ${fmtInt(cur.rxPackets)}    TX  ${fmtInt(cur.txPackets)}`,
      '', s.label('ERRORS / DROPS'), `RX  ${fmtInt(cur.rxErrors)} / ${fmtInt(cur.rxDropped)}    TX  ${fmtInt(cur.txErrors)} / ${fmtInt(cur.txDropped)}`,
      '', s.dim(`refresh ${interval}s · Ctrl+C to stop`),
    ].join('\n'));
  }
  if (!ctx.json) ctx.out.line(s.dim('\nMonitor stopped.'));
}

/* ================================================================ definitions */

const clientOptions = {
  duration: { type: 'number', alias: 't', desc: 'test length in seconds (default 10)' },
  streams: { type: 'number', alias: 'P', desc: 'parallel streams (default 1)' },
  reverse: { type: 'bool', alias: 'R', desc: 'server sends, this host receives' },
  port: { type: 'number', alias: 'p', desc: 'server port (default 5201)' },
};

const trafficWarning = (ctx, what) => ({
  title: 'WARNING',
  lines: [`This ${what} will push as much traffic as it can through the network for ${ctx.opts.duration ?? 10} seconds`, 'and may disturb other users, video streams or control traffic on the same link.', '', 'Target:', ctx.args[0]],
  prompt: 'Continue?',
});

const defs = [
  {
    path: 'bandwidth server', summary: 'Start an iperf3 server so another host can measure throughput to this one',
    usage: 'bandwidth server [--port <n>] [--one-off]', options: { port: { type: 'number', alias: 'p', desc: 'listen port (default 5201)' }, 'one-off': { type: 'bool', desc: 'exit after one test' } },
    confirm: ctx => ({ title: 'WARNING', lines: [`This opens iperf3 on port ${ctx.opts.port ?? 5201} (TCP and UDP) on every interface of this machine until you press Ctrl+C.`, 'Anyone who can reach this host may run a throughput test against it.'], prompt: 'Start server?' }),
    run: runServer,
  },
  {
    path: 'bandwidth client', summary: 'Measure TCP throughput to an iperf3 server', usage: 'bandwidth client <host> [--duration <s>] [--streams <n>] [--reverse] [--port <n>]',
    args: { min: 1, max: 1, names: ['host'] }, options: clientOptions,
    examples: ['bandwidth client 192.168.1.20', 'bandwidth client 192.168.1.20 --duration 10 --streams 4', 'bandwidth client 192.168.1.20 --reverse'],
    confirm: ctx => trafficWarning(ctx, 'throughput test'), run: ctx => runClient(ctx, false),
  },
  {
    path: 'bandwidth udp', summary: 'Measure UDP throughput, jitter and packet loss at a fixed rate', usage: 'bandwidth udp <host> [--rate 100M] [--duration <s>] [--length <bytes>]',
    args: { min: 1, max: 1, names: ['host'] }, options: { ...clientOptions, rate: { type: 'string', alias: 'b', desc: 'target bitrate, e.g. 100M (default 100M)' }, length: { type: 'number', alias: 'l', desc: 'datagram size in bytes' } },
    examples: ['bandwidth udp 192.168.1.20 --rate 100M', 'bandwidth udp 192.168.1.20 --rate 20M --length 1400'],
    confirm: ctx => trafficWarning(ctx, `UDP test at ${ctx.opts.rate ?? '100M'}`), run: ctx => runClient(ctx, true),
  },
  {
    path: 'monitor bandwidth', summary: 'Live RX/TX rates from the interface counters', usage: 'monitor bandwidth [interface] [--interval <s>] [--count <n>]',
    args: { min: 0, max: 1, names: ['interface'] }, options: { interval: { type: 'number', desc: 'refresh seconds (default 1)' }, count: { type: 'number', alias: 'n', desc: 'stop after n samples' } },
    examples: ['monitor bandwidth', 'monitor bandwidth eth0 --interval 0.5', 'monitor bandwidth eth0 --json --count 10'],
    run: runMonitor,
  },
];

module.exports = Object.assign(defs, { parsers: { parseIperf, RATE_RE } });
