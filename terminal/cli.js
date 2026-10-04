#!/usr/bin/env node
'use strict';
/**
 * Terminal command-line front end — same commands as the in-app terminal, for SSH sessions and scripts.
 *   node terminal/cli.js                       interactive terminal
 *   node terminal/cli.js ping 192.168.1.1      run one command and exit (exit status = command status)
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createTerminal } = require('./core');
const { helpText } = require('./help');
const { makeStyle } = require('./output/terminal');
const { containsSecret } = require('./logging/logger');
const { tokenize } = require('./parser');
const platform = require('./system/platform');
const config = require('./config');

const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const tty = !!process.stdout.isTTY;
const style = makeStyle(color);
const term = createTerminal();

let frameLines = 0, pendingFrame = null;
function flushFrame() { if (pendingFrame !== null) { process.stdout.write(pendingFrame + '\n'); pendingFrame = null; } }
function write(ev) {
  if (ev.type === 'out') { flushFrame(); frameLines = 0; process.stdout.write(ev.data); }
  else if (ev.type === 'frame' && !tty) pendingFrame = ev.data;   // piped output: keep only the latest frame
  else if (ev.type === 'frame') {
    if (frameLines) process.stdout.write(`\x1b[${frameLines}A\x1b[0J`);
    process.stdout.write(ev.data + '\n');
    frameLines = ev.data.split('\n').length;
  }
}

const quoteArg = a => (/[\s"'\\]/.test(a) || a === '' ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a);

/* ------------------------------------------------------------------ one-shot */

async function oneShot(argv) {
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const code = await term.execute(argv.map(quoteArg).join(' '), { emit: write, signal: ac.signal, color, confirm: askYesNo });
  flushFrame();
  process.exit(code);
}

/* ------------------------------------------------------------------ interactive */

const HISTORY_FILE = path.join(config.dataDir, 'netterm_history');
let rl = null;

function loadHistory() {
  try { return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-config.defaults.historyLimit).reverse(); } catch { return []; }
}
function persist(line) {
  if (containsSecret(line)) return;                 // never write credentials to disk
  try { fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); fs.appendFileSync(HISTORY_FILE, line + '\n', { mode: 0o600 }); } catch { /* history is best-effort */ }
}

function askYesNo(label) {
  return new Promise(resolve => {
    const q = `${label} [y/N] `;
    if (rl) rl.question(q, a => resolve(/^y(es)?$/i.test(a.trim())));
    else {
      const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
      tmp.question(q, a => { tmp.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    }
  });
}

async function interactive() {
  const user = platform.username(), host = platform.hostname();
  const prompt = `${style.green(`${user}@${host}`)}${style.gray(':')}${style.blue('~')}${style.gray('$')} `;
  process.stdout.write(`${term.banner(style)}\n\n${term.renderCapabilities(style)}\n\nType ${style.cyan('help')} for commands.\n\n`);

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt, history: loadHistory(), historySize: config.defaults.historyLimit, terminal: tty });
  const history = [];
  const aliases = new Map();
  let active = null;

  rl.on('SIGINT', () => {
    if (active) { active.abort(); return; }
    process.stdout.write('\n');
    rl.line = ''; rl.prompt();
  });

  rl.prompt();
  for await (const raw of rl) {
    let line = raw.trim();
    if (!line) { rl.prompt(); continue; }

    // history expansion
    if (line === '!!' || /^!\d+$/.test(line)) {
      const entry = line === '!!' ? history[history.length - 1] : history[Number(line.slice(1)) - 1];
      if (!entry) { process.stdout.write(`${style.err('ERROR:')} no such history entry\n`); rl.prompt(); continue; }
      process.stdout.write(style.dim(entry) + '\n'); line = entry;
    }
    const [first, ...rest] = (() => { try { return tokenize(line); } catch { return [line]; } })();
    if (aliases.has(first)) line = `${aliases.get(first)} ${rest.map(quoteArg).join(' ')}`.trim();

    history.push(line); persist(line);

    if (first === 'exit' || first === 'quit') break;
    if (first === 'clear') { process.stdout.write('\x1b[2J\x1b[H'); rl.prompt(); continue; }
    if (first === 'history') { history.forEach((h, i) => process.stdout.write(`${String(i + 1).padStart(4)}  ${containsSecret(h) ? '[redacted]' : h}\n`)); rl.prompt(); continue; }
    if (first === 'help') { process.stdout.write(helpText(rest[0], color) + '\n'); rl.prompt(); continue; }
    if (first === 'alias') {
      const m = /^alias\s+(\S+?)=(.+)$/.exec(line);
      if (m) aliases.set(m[1], m[2].replace(/^["']|["']$/g, ''));
      else if (rest.length === 0) for (const [k, v] of aliases) process.stdout.write(`alias ${k}="${v}"\n`);
      else process.stdout.write(`${style.err('ERROR:')} usage: alias name="command"\n`);
      rl.prompt(); continue;
    }

    active = new AbortController();
    try { await term.execute(line, { emit: write, signal: active.signal, color, confirm: askYesNo }); }
    finally { active = null; flushFrame(); }
    process.stdout.write('\n');
    rl.prompt();
  }
  rl.close();
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.length) oneShot(args); else interactive();
