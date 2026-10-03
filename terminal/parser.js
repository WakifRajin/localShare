'use strict';
/**
 * Command-line parsing. No shell semantics at all: no globbing, no variable expansion, no
 * command substitution, no pipes — just words, quotes and options.
 */
const { CmdError } = require('./errors');

/** Split a line into words. Supports 'single', "double" quotes and backslash escapes. */
function tokenize(line) {
  const out = [];
  let cur = '', inWord = false, quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length && /["\\]/.test(line[i + 1])) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; inWord = true; }
    else if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; inWord = true; }
    else if (/\s/.test(ch)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } }
    else { cur += ch; inWord = true; }
  }
  if (quote) throw new CmdError('USAGE', `unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (inWord) out.push(cur);
  return out;
}

const GLOBAL_OPTIONS = {
  help:    { type: 'bool', alias: 'h', desc: 'show help for this command' },
  verbose: { type: 'bool', alias: 'v', desc: 'more detail' },
  json:    { type: 'bool', desc: 'machine-readable JSON output' },
  quiet:   { type: 'bool', alias: 'q', desc: 'minimal output' },
  yes:     { type: 'bool', alias: 'y', desc: 'skip confirmation prompts' },
};

/**
 * @param {string[]} tokens   words after the command path
 * @param {object} spec       { name: { type:'bool'|'string'|'number', alias?, desc?, default? } }
 * @returns {{ args: string[], opts: object }}
 */
function parseArgs(tokens, spec = {}) {
  const all = { ...GLOBAL_OPTIONS, ...spec };
  const byAlias = {};
  for (const [name, o] of Object.entries(all)) if (o.alias) byAlias[o.alias] = name;
  const opts = {};
  for (const [name, o] of Object.entries(all)) if (o.default !== undefined) opts[name] = o.default;
  const args = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { args.push(...tokens.slice(i + 1)); break; }
    const isLong = t.startsWith('--') && t.length > 2;
    const isShort = !isLong && /^-[A-Za-z]/.test(t);
    if (!isLong && !isShort) { args.push(t); continue; }

    let name, inline;
    if (isLong) {
      const eq = t.indexOf('=');
      name = eq > 0 ? t.slice(2, eq) : t.slice(2);
      inline = eq > 0 ? t.slice(eq + 1) : undefined;
    } else {
      name = byAlias[t[1]];
      inline = t.length > 2 ? t.slice(2) : undefined;           // -c10
      if (!name) throw new CmdError('USAGE', `unknown option '${t.slice(0, 2)}'`, { hints: ['Use --help to see the options for this command.'] });
    }
    const def = all[name];
    if (!def) {
      const near = Object.keys(all).find(k => k.startsWith(name.slice(0, 3)));
      throw new CmdError('USAGE', `unknown option '--${name}'`, { hints: [near ? `Did you mean --${near}?` : 'Use --help to see the options for this command.'] });
    }
    if (def.type === 'bool') {
      if (inline !== undefined && isLong) { opts[name] = !/^(0|false|no)$/i.test(inline); }
      else opts[name] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      if (i + 1 >= tokens.length) throw new CmdError('USAGE', `option '--${name}' needs a value`);
      value = tokens[++i];
    }
    if (def.type === 'number') {
      const n = Number(value);
      if (value === '' || !Number.isFinite(n)) throw new CmdError('INVALID', `option '--${name}' needs a number, got '${value}'`);
      opts[name] = n;
    } else opts[name] = value;
  }
  return { args, opts };
}

module.exports = { tokenize, parseArgs, GLOBAL_OPTIONS };
