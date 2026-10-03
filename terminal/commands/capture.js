'use strict';
/** capture <interface> [--host ip] [--port n] [--tcp|--udp] [--count n] [--output file.pcap] */
const fs = require('fs');
const path = require('path');
const runner = require('../system/command_runner');
const platform = require('../system/platform');
const perms = require('../system/permissions');
const counters = require('../monitoring/counters');
const config = require('../config');
const { CmdError } = require('../errors');
const V = require('../system/validate');
const { fmtInt, padEnd } = require('../output/terminal');

/* ================================================================ parsers (pure) */

function splitAddr(a) {
  // tcpdump -n prints "192.168.1.20.5000" or "fe80::1.5353" — the last dot-separated field is the port
  const m = /^(.*)\.(\d+)$/.exec(a);
  return m ? `${m[1]}:${m[2]}` : a;
}

/** One `tcpdump -n -q -l` line -> {time, src, dst, proto, info} | null */
function parseTcpdumpLine(line) {
  let m = /^(\d\d:\d\d:\d\d)\.\d+\s+(IP6?)\s+(\S+)\s+>\s+(\S+?):\s+(.*)$/.exec(line);
  if (m) {
    const rest = m[5];
    let proto = m[2] === 'IP6' ? 'IPv6' : 'IP', info = rest;
    const len = /length (\d+)/.exec(rest) || /^(?:tcp|UDP)\s+(\d+)/i.exec(rest);
    if (/^UDP/i.test(rest)) proto = 'UDP';
    else if (/^tcp/i.test(rest)) proto = 'TCP';
    else if (/^ICMP6?/i.test(rest)) proto = rest.slice(0, 5).replace(/[ ,].*/, '').toUpperCase();
    if ((proto === 'UDP' || proto === 'TCP') && len) info = `${len[1]} bytes`;
    return { time: m[1], src: splitAddr(m[3]), dst: splitAddr(m[4]), proto, info };
  }
  m = /^(\d\d:\d\d:\d\d)\.\d+\s+ARP,\s+(.*)$/.exec(line);
  if (m) {
    const who = /who-has (\S+) tell (\S+?),/.exec(m[2]) || [];
    return { time: m[1], src: who[2] || '-', dst: who[1] || 'broadcast', proto: 'ARP', info: m[2].replace(/, length \d+$/, '') };
  }
  m = /^(\d\d:\d\d:\d\d)\.\d+\s+(\S+)\s+>\s+(\S+),\s+(.*)$/.exec(line);       // link-level (-e) or other frames
  if (m) return { time: m[1], src: m[2], dst: m[3], proto: 'L2', info: m[4] };
  return null;
}

/** tcpdump's closing statistics (stderr) */
function parseTcpdumpSummary(text) {
  const g = re => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  return { captured: g(/(\d+) packets? captured/), receivedByFilter: g(/(\d+) packets? received by filter/), droppedByKernel: g(/(\d+) packets? dropped by kernel/) };
}

/** Build the BPF filter as separate argv words (never a shell string). */
function buildFilter({ host, port, tcp, udp }) {
  const parts = [];
  if (host) parts.push(['host', host]);
  if (port) parts.push(['port', String(port)]);
  if (tcp && !udp) parts.push(['tcp']);
  if (udp && !tcp) parts.push(['udp']);
  return parts.flatMap((p, i) => (i ? ['and', ...p] : p));
}

function safeCaptureFile(name) {
  if (!/^[A-Za-z0-9][\w.-]{0,80}$/.test(name)) throw new CmdError('INVALID', `invalid file name '${name}'`, { hints: ['Use a plain file name (letters, digits, . _ -); it is saved under ' + config.captureDir] });
  const file = name.endsWith('.pcap') ? name : `${name}.pcap`;
  fs.mkdirSync(config.captureDir, { recursive: true, mode: 0o700 });
  return path.join(config.captureDir, file);
}

/* ================================================================ command */

const def = {
  path: 'capture',
  summary: 'Capture packets on an interface (tcpdump) with live one-line summaries',
  usage: 'capture <interface> [--host <ip>] [--port <n>] [--tcp] [--udp] [--count <n>] [--output <file.pcap>]',
  args: { min: 1, max: 1, names: ['interface'] },
  options: {
    host: { type: 'string', desc: 'only packets to/from this host' }, port: { type: 'number', desc: 'only this TCP/UDP port' },
    tcp: { type: 'bool', desc: 'TCP only' }, udp: { type: 'bool', desc: 'UDP only' }, count: { type: 'number', alias: 'c', desc: 'stop after n packets' },
    output: { type: 'string', alias: 'o', desc: `also save to a .pcap file under ${config.captureDir}` },
  },
  examples: ['capture eth0', 'capture eth0 --host 192.168.1.20 --udp', 'capture eth0 --port 8080 --output web.pcap'],

  confirm: () => ({
    title: 'NOTICE',
    lines: ['Packet capture will inspect traffic visible on this interface.', 'Use only on networks you are authorized to monitor.'],
    prompt: 'Start capture?',
  }),

  async run(ctx) {
    if (platform.isWindows) throw new CmdError('UNSUPPORTED_PLATFORM', 'packet capture needs tcpdump, which is not available on Windows.', { hints: ['Use Wireshark/dumpcap, or run this terminal on a Linux/macOS machine.'] });
    const o = ctx.opts;
    runner.need('tcpdump', 'required for packet capture');
    const iface = ctx.args[0] === 'any' && platform.isLinux ? 'any' : await counters.requireInterface(V.validIface(ctx.args[0]), { signal: ctx.signal });
    ctx.meta.target = iface;
    if (o.host !== undefined) { const t = V.parseTarget(o.host); if (t.kind === 'cidr') throw new CmdError('INVALID', '--host takes a single address'); }
    const port = o.port === undefined ? undefined : V.parsePort(o.port);
    const count = o.count === undefined ? undefined : V.parseNumber(o.count, 'count', { min: 1, max: 10_000_000, int: true });
    const file = o.output ? safeCaptureFile(o.output) : null;
    const filter = buildFilter({ host: o.host, port, tcp: o.tcp, udp: o.udp });

    const args = ['-i', iface, '-n', '-l', ...(count ? ['-c', count] : []), ...(file ? ['-w', file, '-U'] : ['-q']), ...filter];
    const s = ctx.style;
    ctx.out.line(`${s.head('CAPTURE')} ${iface}${filter.length ? s.dim('  filter: ' + filter.join(' ')) : ''}${file ? s.dim('  → ' + file) : ''}`);
    ctx.out.line(s.dim('Press Ctrl+C to stop.\n'));
    if (!file && !ctx.json) ctx.out.line(s.gray(padEnd('TIME', 10) + padEnd('SRC', 24) + padEnd('DST', 24) + padEnd('PROTO', 8) + 'INFO'));

    const packets = [];
    let seen = 0;
    const r = await runner.run('tcpdump', args, {
      signal: ctx.signal,
      onLine: line => {
        const p = parseTcpdumpLine(line);
        if (!p) return;
        seen++;
        if (packets.length < 5000) packets.push(p);
        if (!ctx.json) ctx.out.line(padEnd(p.time, 10) + padEnd(p.src, 24) + padEnd(p.dst, 24) + padEnd(p.proto, 8) + p.info);
      },
    });

    if (!r.aborted && r.code !== 0 && !seen) {
      if (perms.looksLikePermissionError(r.stderr)) throw new CmdError('PERMISSION', 'packet capture needs elevated privileges.', { hints: perms.captureHint('tcpdump') });
      if (/no suitable device|no such device|doesn't exist/i.test(r.stderr)) throw new CmdError('NOT_FOUND', `interface '${iface}' cannot be captured on.`);
      if (/syntax error|can't parse filter/i.test(r.stderr)) throw new CmdError('INVALID', 'tcpdump rejected the filter: ' + (r.stderr.trim().split('\n').pop()));
      throw new CmdError('FAILED', r.stderr.trim().split('\n').find(l => l && !/^tcpdump: (verbose|listening)/i.test(l)) || 'tcpdump failed');
    }
    const sum = parseTcpdumpSummary(r.stderr);
    ctx.out.result({ interface: iface, filter: filter.join(' ') || null, file, summary: sum, displayed: seen, packets }, d => {
      ctx.out.line(s.dim(`\n${fmtInt(d.summary.captured ?? d.displayed)} packets captured` + (d.summary.droppedByKernel ? `, ${fmtInt(d.summary.droppedByKernel)} dropped by the kernel (capture could not keep up)` : '') + (d.file ? `\nSaved: ${d.file}  (open with Wireshark or: tcpdump -nr ${d.file})` : '')));
    });
    if (r.aborted) return; // Ctrl+C is the normal way to stop a capture
  },
};

module.exports = Object.assign([def], { parsers: { parseTcpdumpLine, parseTcpdumpSummary, buildFilter, splitAddr } });
