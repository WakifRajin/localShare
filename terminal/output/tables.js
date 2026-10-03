'use strict';
const { padEnd, padStart, visibleLength } = require('./terminal');

/**
 * Plain aligned columns (no borders), the way ip/ss/netstat print them.
 * columns: [{ key, title, align?: 'left'|'right', format?: (value,row)=>string, color?: (text,row)=>string }]
 */
function renderTable(style, columns, rows, { indent = 0, gap = 3, empty = '(none)' } = {}) {
  if (!rows.length) return ' '.repeat(indent) + style.dim(empty);
  const cells = rows.map(r => columns.map(c => {
    const raw = c.format ? c.format(r[c.key], r) : (r[c.key] ?? '');
    const text = raw === null || raw === undefined || raw === '' ? 'N/A' : String(raw);
    return { text, shown: c.color ? c.color(text, r) : text };
  }));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map(row => visibleLength(row[i].text))));
  const pad = ' '.repeat(indent), sep = ' '.repeat(gap);
  const head = pad + columns.map((c, i) => style.gray(c.align === 'right' ? padStart(c.title, widths[i]) : padEnd(c.title, widths[i]))).join(sep).trimEnd();
  const lines = cells.map(row => pad + columns.map((c, i) => c.align === 'right' ? padStart(row[i].shown, widths[i]) : padEnd(row[i].shown, widths[i])).join(sep).trimEnd());
  return [head, ...lines].join('\n');
}

module.exports = { renderTable };
