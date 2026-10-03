'use strict';
/**
 * Argument validation. Commands are executed WITHOUT a shell, but values still end up as
 * argv entries of other programs, so we reject anything that could be read as an option
 * (leading "-") or that isn't a well-formed address / name / number.
 */
const net = require('net');
const { CmdError } = require('../errors');

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(?:\.(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?))*\.?$/;
const IFACE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@ -]{0,39}$/; // Windows names contain spaces ("Wi-Fi", "Ethernet 2")

const isIPv4 = v => net.isIPv4(v);
const isIPv6 = v => net.isIPv6(v);
const isIP = v => net.isIP(v) !== 0;

function isHostname(v) {
  return typeof v === 'string' && !v.startsWith('-') && !isIP(v) && HOSTNAME_RE.test(v);
}

function parseCIDR(v) {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(v || '');
  if (!m) return null;
  const bits = Number(m[2]);
  if (net.isIPv4(m[1]) && bits >= 0 && bits <= 32) return { ip: m[1], bits, family: 4 };
  if (net.isIPv6(m[1]) && bits >= 0 && bits <= 128) return { ip: m[1], bits, family: 6 };
  return null;
}

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0; }
function intToIpv4(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }

/** Expand an IPv4 CIDR into host addresses (network/broadcast excluded for /30 and larger). */
function expandCIDR4(cidr, limit = 65536) {
  const c = typeof cidr === 'string' ? parseCIDR(cidr) : cidr;
  if (!c || c.family !== 4) throw new CmdError('INVALID', `invalid IPv4 CIDR '${cidr}'`);
  const size = 2 ** (32 - c.bits);
  if (size > limit) throw new CmdError('INVALID', `${c.ip}/${c.bits} covers ${size} addresses; the limit here is ${limit}`);
  const base = (ipv4ToInt(c.ip) & ((0xFFFFFFFF << (32 - c.bits)) >>> 0)) >>> 0;
  const out = [];
  const [from, to] = size > 2 ? [base + 1, base + size - 2] : [base, base + size - 1];
  for (let i = from; i <= to; i++) out.push(intToIpv4(i >>> 0));
  return out;
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
function isPrivateIPv6(ip) {
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('fc') || l.startsWith('fd');
}
const isPrivateIP = ip => (net.isIPv4(ip) ? isPrivateIPv4(ip) : net.isIPv6(ip) ? isPrivateIPv6(ip) : false);

/** @returns {{kind:'ip'|'host'|'cidr', value:string, family?:number}} or throws INVALID */
function parseTarget(v) {
  if (typeof v !== 'string' || !v || v.startsWith('-')) throw new CmdError('INVALID', `invalid target '${v ?? ''}'`);
  if (isIP(v)) return { kind: 'ip', value: v, family: net.isIP(v) };
  const c = parseCIDR(v);
  if (c) return { kind: 'cidr', value: v, family: c.family, cidr: c };
  if (v.includes('/')) throw new CmdError('INVALID', `invalid CIDR '${v}'`, { hints: ['Example: 192.168.1.0/24'] });
  if (isHostname(v)) return { kind: 'host', value: v };
  throw new CmdError('INVALID', `invalid target '${v}' (expected an IP address, hostname or CIDR)`);
}

function parsePort(v, what = 'port') {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n < 1 || n > 65535) throw new CmdError('INVALID', `invalid ${what} '${v}' (expected 1-65535)`);
  return n;
}

function parsePortList(v) {
  const ports = new Set();
  for (const part of String(v).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new CmdError('INVALID', `invalid port list '${v}'`, { hints: ['Examples: 22,80,443   1-1024'] });
    const a = parsePort(m[1]), b = m[2] ? parsePort(m[2]) : a;
    if (b < a) throw new CmdError('INVALID', `invalid port range '${part}'`);
    for (let p = a; p <= b; p++) ports.add(p);
  }
  return [...ports];
}

function parseNumber(v, name, { min = -Infinity, max = Infinity, int = false } = {}) {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new CmdError('INVALID', `invalid ${name} '${v}' (expected ${int ? 'an integer' : 'a number'} ${Number.isFinite(min) ? 'from ' + min : ''}${Number.isFinite(max) ? ' to ' + max : ''})`.replace(/\s+\)/, ')'));
  }
  return n;
}

function validIface(v) {
  if (typeof v !== 'string' || !IFACE_RE.test(v)) throw new CmdError('INVALID', `invalid interface name '${v ?? ''}'`);
  return v;
}

module.exports = {
  isIPv4, isIPv6, isIP, isHostname, parseCIDR, expandCIDR4, ipv4ToInt, intToIpv4,
  isPrivateIPv4, isPrivateIPv6, isPrivateIP, parseTarget, parsePort, parsePortList, parseNumber, validIface,
};
