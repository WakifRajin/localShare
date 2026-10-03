#!/usr/bin/env node
'use strict';
/**
 * Embeds the help text and command list into docs/index.html so the in-app terminal has the SAME
 * help as the CLI even on the hosted site (where there is no agent to ask).
 *   node terminal/build-web.js          rewrite the block in docs/index.html
 *   node terminal/build-web.js --check  exit 1 if the embedded block is out of date
 */
const fs = require('fs');
const path = require('path');
const { TOPICS, helpText } = require('./help');
const registry = require('./registry');

const FILE = path.join(__dirname, '..', 'docs', 'index.html');
const BEGIN = '/*HELP:BEGIN*/', END = '/*HELP:END*/';

const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
// Keep the JSON safe to embed inside an inline <script>: no '</script', no raw line separators.
const esc = code => '\\u' + code;
const safe = obj => JSON.stringify(obj).split('<').join(esc('003c')).split(LS).join(esc('2028')).split(PS).join(esc('2029'));

function block() {
  const help = {};
  for (const key of Object.keys(TOPICS)) help[key] = helpText(key, true);
  const commands = [...new Set([...registry.commands.keys(), ...[...registry.commands.keys()].map(k => k.split(' ')[0])])].sort();
  return `${BEGIN}\nconst TTY_HELP = ${safe(help)};\nconst TTY_COMMANDS = ${safe(commands)};\n${END}`;
}

function embed(html) {
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('HELP markers not found in docs/index.html');
  return html.slice(0, a) + block() + html.slice(b + END.length);
}

if (require.main === module) {
  const html = fs.readFileSync(FILE, 'utf8');
  const next = embed(html);
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('docs/index.html help block is stale — run: node terminal/build-web.js'); process.exit(1); }
    console.log('help block is up to date');
  } else {
    fs.writeFileSync(FILE, next);
    console.log('updated docs/index.html help block');
  }
}

module.exports = { block, embed };
