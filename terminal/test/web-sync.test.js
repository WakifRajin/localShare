'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { embed } = require('../build-web');

test('the help text embedded in docs/index.html matches the CLI help (run: node terminal/build-web.js)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
  assert.equal(embed(html), html);
});

test('the page script contains no leftover references to the old collaborative shell', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
  for (const gone of ['sendTerminal', 'appendTerminalLine', "type:'term'"]) assert.ok(!html.includes(gone), gone);
});

test('every inline <script> in docs/index.html parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 3);
  for (const [i, m] of blocks.entries()) assert.doesNotThrow(() => new Function(m[1]), `script block ${i}`);
});
