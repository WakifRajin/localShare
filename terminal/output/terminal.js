'use strict';
/** Human-readable presentation helpers: ANSI styling, number formatting, banners, key/value blocks. */

const CODES = { bold: 1, dim: 2, underline: 4, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 };
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const strip = s => String(s).replace(ANSI_RE, '');
const visibleLength = s => strip(s).length;

/** Returns style functions; with enabled=false every function is the identity (JSON mode, NO_COLOR, pipes). */
function makeStyle(enabled) {
  const wrap = code => enabled ? s => `\x1b[${code}m${s}\x1b[0m` : s => String(s);
  const st = {};
  for (const [name, code] of Object.entries(CODES)) st[name] = wrap(code);
  st.enabled = enabled;
  // semantic helpers
  st.ok = st.green; st.warn = st.yellow; st.err = st.red; st.label = st.gray; st.head = s => st.bold(st.white(s));
  return st;
}

function padEnd(s, w) { const n = w - visibleLength(s); return n > 0 ? s + ' '.repeat(n) : s; }
function padStart(s, w) { const n = w - visibleLength(s); return n > 0 ? ' '.repeat(n) + s : s; }

function fmtBytes(b) {
  if (b === null || b === undefined || Number.isNaN(b)) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(b), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
/** bits per second -> "998 Mbps" (decimal, as networks are rated) */
function fmtRate(bps) {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return 'N/A';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let v = Number(bps), i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
const fmtMs = ms => (ms === null || ms === undefined || Number.isNaN(ms)) ? 'N/A' : Number.isInteger(ms) ? `${ms} ms` : `${ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)} ms`;
const fmtInt = n => (n === null || n === undefined || Number.isNaN(n)) ? 'N/A' : Number(n).toLocaleString('en-US');
const fmtPct = p => (p === null || p === undefined || Number.isNaN(p)) ? 'N/A' : `${p.toFixed(1)}%`;
const na = v => (v === null || v === undefined || v === '') ? 'N/A' : v;

function banner(style, title, subtitle, width = 64) {
  const inner = width - 2;
  const text = ` ${title}  •  ${subtitle}`;
  const pad = Math.max(0, inner - text.length);
  return [
    style.gray('╭' + '─'.repeat(inner) + '╮'),
    style.gray('│') + style.bold(` ${title}`) + style.gray(`  •  ${subtitle}`) + ' '.repeat(pad) + style.gray('│'),
    style.gray('╰' + '─'.repeat(inner) + '╯'),
  ].join('\n');
}

/** Aligned "LABEL    value" block. pairs: [label, value] or null for a blank line. */
function kv(style, pairs, { labelWidth } = {}) {
  const w = labelWidth || Math.max(...pairs.filter(Boolean).map(p => String(p[0]).length)) + 2;
  return pairs.map(p => p ? padEnd(style.label(String(p[0])), w) + p[1] : '').join('\n');
}

/** 20-cell horizontal bar. */
function bar(style, fraction, width = 20) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  return style.green('█'.repeat(filled)) + style.gray('░'.repeat(width - filled));
}

module.exports = { makeStyle, strip, visibleLength, padEnd, padStart, fmtBytes, fmtRate, fmtMs, fmtInt, fmtPct, na, banner, kv, bar };
