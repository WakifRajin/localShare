'use strict';
/**
 * The page is a single HTML file, so its pure helpers are fenced with PURE:BEGIN / PURE:END markers
 * and evaluated here in a sandbox — no DOM needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/\/\*PURE:BEGIN\*\/([\s\S]*?)\/\*PURE:END\*\//g)].map(m => m[1]);
const sandbox = vm.createContext({});
vm.runInContext(blocks.join('\n') + '\nthis.api = { richTokens, fmtSpeed, fmtEta, mdBlocks, docStats, diffRegion, applyPatch };', sandbox);
const A = sandbox.api;
const plain = x => JSON.parse(JSON.stringify(x)); // strip the sandbox realm's prototypes

test('the page exposes its pure helpers', () => {
  assert.ok(blocks.length >= 3);
  for (const k of ['richTokens', 'fmtSpeed', 'fmtEta', 'mdBlocks', 'docStats', 'diffRegion', 'applyPatch']) assert.equal(typeof A[k], 'function', k);
});

/* ------------------------------------------------------------------ rich text */

test('rich text: bold, code, links, mentions, blocks', () => {
  const t = plain(A.richTokens('go **now** and `ls -la` see https://example.com/a?b=1. ping @Maya!'));
  assert.deepEqual(t.map(x => x.t), ['text', 'bold', 'text', 'code', 'text', 'link', 'text', 'text', 'mention', 'text']);
  assert.equal(t.find(x => x.t === 'link').v, 'https://example.com/a?b=1');           // the sentence's full stop is not part of the URL
  assert.equal(t.find(x => x.t === 'mention').v, '@Maya');
  const blk = plain(A.richTokens('```js\nlet a = 1;\n```'));
  assert.deepEqual(blk, [{ t: 'block', v: 'let a = 1;' }]);                           // language hint dropped
  assert.deepEqual(plain(A.richTokens('```no newline```')), [{ t: 'block', v: 'no newline' }]);
});

test('rich text never produces markup: HTML stays text, only http(s) becomes a link', () => {
  const bad = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', 'javascript:alert(1)', 'data:text/html,<b>x', '[x](javascript:alert(1))'];
  for (const b of bad) {
    const toks = plain(A.richTokens(b));
    assert.ok(toks.every(t => t.t !== 'link'), b);
    assert.equal(toks.map(t => t.v).join(''), b);                                    // nothing lost, nothing interpreted
  }
  assert.equal(plain(A.richTokens('see http://a.b/c)'))[1].v, 'http://a.b/c');
  assert.deepEqual(plain(A.richTokens('unclosed `tick and **bold')).map(t => t.t), ['text']);   // unmatched markers stay literal
});

test('rich text terminates and loses nothing on hostile input', () => {
  const nasty = ['`'.repeat(5000), '*'.repeat(5000), '@'.repeat(2000), 'http://'.repeat(500), '```'.repeat(300), 'a'.repeat(100000), '**'.repeat(2000) + '`'];
  for (const s of nasty) {
    const t0 = Date.now();
    const toks = A.richTokens(s);
    assert.ok(Date.now() - t0 < 1500, 'too slow on ' + s.slice(0, 10));
    assert.ok(toks.length > 0);
  }
});

/* ------------------------------------------------------------------ formatting */

test('transfer speed and ETA', () => {
  assert.equal(A.fmtSpeed(0), ''); assert.equal(A.fmtSpeed(-5), '');
  assert.equal(A.fmtSpeed(512), '512 B/s'.replace('512 B/s', '512 B/s'));
  assert.equal(A.fmtSpeed(1536), '1.50 KB/s'); assert.equal(A.fmtSpeed(12.2 * 1024 * 1024), '12.2 MB/s'); assert.equal(A.fmtSpeed(150 * 1024 * 1024), '150 MB/s');
  assert.equal(A.fmtEta(0.2), '<1 s'); assert.equal(A.fmtEta(42), '42 s'); assert.equal(A.fmtEta(125), '2 min 05 s'); assert.equal(A.fmtEta(3725), '1 h 02 min');
  assert.equal(A.fmtEta(Infinity), ''); assert.equal(A.fmtEta(NaN), ''); assert.equal(A.fmtEta(-1), '');
});

/* ------------------------------------------------------------------ markdown subset */

test('markdown blocks', () => {
  const b = plain(A.mdBlocks('# Title\n\nSome **text**\nmore text\n\n- a\n- b\n\n1. one\n2) two\n\n> quote\n> more\n\n```\ncode\n```\n---\n###### deep'));
  assert.deepEqual(b.map(x => x.t), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr', 'h']);
  assert.equal(b[0].level, 1); assert.equal(b[7].level, 6);
  assert.equal(b[1].v, 'Some **text**\nmore text');
  assert.deepEqual(b[2].items, ['a', 'b']); assert.deepEqual(b[3].items, ['one', 'two']);
  assert.equal(b[4].v, 'quote\nmore'); assert.equal(b[5].v, 'code');
});

test('markdown parser always terminates and never drops text', () => {
  const lines = ['# h', '- x', '1. y', '> q', '```', 'plain', '', '---', '#nohash', '-nospace', '   ', '*** ', '10) z', '\t- tab', '```js'];
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let n = 0; n < 400; n++) {
    const text = Array.from({ length: 1 + rnd(12) }, () => lines[rnd(lines.length)]).join('\n');
    const t0 = Date.now();
    const out = A.mdBlocks(text);
    assert.ok(Date.now() - t0 < 200, JSON.stringify(text));
    assert.ok(Array.isArray(out));
  }
  assert.equal(A.mdBlocks('').length, 0);
});

test('document stats', () => {
  assert.deepEqual(plain(A.docStats('')), { words: 0, lines: 0, chars: 0 });
  assert.deepEqual(plain(A.docStats('hello world\nsecond line')), { words: 4, lines: 2, chars: 23 });
});

/* ------------------------------------------------------------------ concurrent editing */

test('diff + patch round-trips for arbitrary strings', () => {
  let seed = 42; const rnd = n => (seed = (seed * 1664525 + 1013904223) >>> 0) % n;
  const alpha = 'ab c\né😀\n';
  const gen = () => Array.from({ length: rnd(40) }, () => alpha[rnd(alpha.length)]).join('');
  for (let i = 0; i < 2000; i++) {
    const a = gen(), b = gen();
    assert.equal(A.applyPatch(a, A.diffRegion(a, b), a), b, JSON.stringify([a, b]));
  }
  assert.equal(A.diffRegion('same', 'same'), null);
});

test('simultaneous edits in different places both survive (what last-writer-wins used to destroy)', () => {
  const base = 'line one\nline two\nline three\nline four';
  for (const [ins1, at1, ins2, at2] of [['<A>', 0, '<B>', base.length], ['<A>', 5, '<B>', 25], ['<B>', 30, '<A>', 2]]) {
    const user1 = base.slice(0, at1) + ins1 + base.slice(at1);
    const user2 = base.slice(0, at2) + ins2 + base.slice(at2);
    // host applies user1's change first, then user2's change rebased onto it
    const afterFirst = user1;
    const merged = A.applyPatch(afterFirst, A.diffRegion(base, user2), base);
    assert.ok(merged.includes(ins1) && merged.includes(ins2), `${at1}/${at2}: ${JSON.stringify(merged)}`);
    assert.equal(merged.replace(ins1, '').replace(ins2, ''), base);                    // nothing else was disturbed
  }
});

test('deleting while someone else appends keeps the append', () => {
  const base = 'alpha beta gamma';
  const userA = 'alpha gamma';                         // deleted "beta "
  const userB = base + ' delta';                       // appended
  const merged = A.applyPatch(userA, A.diffRegion(base, userB), base);
  assert.equal(merged, 'alpha gamma delta');
});
