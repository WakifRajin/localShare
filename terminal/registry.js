'use strict';
/**
 * Command registry. Each module under commands/ exports an array of definitions:
 *   { path: 'net interfaces', summary, usage, options?, args?: {min,max,names}, examples?,
 *     confirm?(ctx) -> {title, lines, prompt}|null,  run(ctx) }
 */
const modules = [
  ['NETWORK',     require('./commands/network')],
  ['DIAGNOSTICS', require('./commands/diagnostics')],
  ['DISCOVERY',   require('./commands/discovery')],
  ['BANDWIDTH',   require('./commands/bandwidth')],
  ['CAPTURE',     require('./commands/capture')],
  ['SECURITY',    require('./commands/security')],
  ['SYSTEM',      require('./commands/meta')],
];

const commands = new Map();
const groups = new Map();      // group title -> definitions
const prefixes = new Set();    // first words that have subcommands ("net", "bandwidth", ...)

for (const [group, defs] of modules) {
  groups.set(group, defs);
  for (const def of defs) {
    def.group = group;
    commands.set(def.path, def);
    const words = def.path.split(' ');
    if (words.length > 1) prefixes.add(words[0]);
  }
}

/** @returns {{def?:object, rest:string[], prefix?:string}} */
function resolve(tokens) {
  for (let n = Math.min(2, tokens.length); n >= 1; n--) {
    const def = commands.get(tokens.slice(0, n).join(' '));
    if (def) return { def, rest: tokens.slice(n) };
  }
  return { rest: tokens, prefix: prefixes.has(tokens[0]) ? tokens[0] : undefined };
}

const subcommands = prefix => [...commands.values()].filter(d => d.path.startsWith(prefix + ' '));
const allNames = () => [...new Set([...commands.keys()].map(k => k.split(' ')[0]))];

module.exports = { commands, groups, resolve, subcommands, allNames, prefixes };
