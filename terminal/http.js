'use strict';
/**
 * HTTP bridge for the in-app terminal (used by server.js).
 *
 * Running diagnostics is only offered to the person sitting at THIS machine:
 *   - the TCP peer must be loopback;
 *   - the Host header must be localhost/127.0.0.1/[::1]  (defeats DNS-rebinding);
 *   - POSTs must be same-origin (Origin header, if present, must match Host), JSON, and carry a
 *     per-process secret token that only same-origin pages can read from /term/info.
 * Commands run through the same safe, shell-free pipeline as the CLI; there is no raw-shell endpoint.
 */
const crypto = require('crypto');
const { createTerminal } = require('./core');
const { renderCapabilities, capabilities } = require('./core');
const config = require('./config');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_RUNS = 4;
const MAX_BODY = 8 * 1024;

function createTerminalHttp({ port } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const term = createTerminal();
  const runs = new Map(); // id -> { abort, pending }

  const json = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };

  const hostOk = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  function guard(req, res, { post }) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) { json(res, 403, { error: 'The terminal is only available on the machine running server.js.' }); return false; }
    if (!hostOk(req)) { json(res, 403, { error: 'Open this page as http://localhost:<port> on the machine running server.js.' }); return false; }
    if (post) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) { json(res, 403, { error: 'cross-origin request refused' }); return false; }
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'expected application/json' }); return false; }
      const got = Buffer.from(String(req.headers['x-term-token'] || ''));
      if (got.length !== tokenBuf.length || !crypto.timingSafeEqual(got, tokenBuf)) { json(res, 401, { error: 'bad token' }); return false; }
    }
    return true;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid JSON')); } });
      req.on('error', reject);
    });
  }

  async function handle(req, res, url) {
    const p = url.pathname;

    if (req.method === 'GET' && p === '/term/info') {
      if (!guard(req, res, { post: false })) return true;
      const style = { enabled: false };
      return json(res, 200, { ok: true, token, ...term.info(), port, capabilities: capabilities() }), true;
    }

    if (req.method === 'POST' && (p === '/term/run' || p === '/term/answer' || p === '/term/cancel')) {
      if (!guard(req, res, { post: true })) return true;
      let body;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }), true; }

      if (p === '/term/answer') { const r = runs.get(String(body.id)); if (r && r.pending) { r.pending(!!body.ok); r.pending = null; } return json(res, 200, { ok: true }), true; }
      if (p === '/term/cancel') { const r = runs.get(String(body.id)); if (r) r.abort.abort(); return json(res, 200, { ok: true }), true; }

      const line = typeof body.line === 'string' ? body.line.slice(0, 2000) : '';
      if (!line.trim()) return json(res, 400, { error: 'empty command' }), true;
      if (runs.size >= MAX_RUNS) return json(res, 429, { error: 'too many commands running — wait for one to finish or press Ctrl+C.' }), true;

      const id = crypto.randomBytes(8).toString('hex');
      const abort = new AbortController();
      const run = { abort, pending: null };
      runs.set(id, run);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      const send = ev => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(ev) + '\n'); };
      res.on('close', () => { if (!res.writableFinished) { abort.abort(); if (run.pending) { run.pending(false); run.pending = null; } } });
      send({ type: 'start', id });

      const io = {
        emit: send, signal: abort.signal, color: true,
        confirm: prompt => new Promise(resolve => {
          run.pending = resolve;
          abort.signal.addEventListener('abort', () => { if (run.pending) { run.pending(false); run.pending = null; } }, { once: true });
          send({ type: 'confirm', prompt });
        }),
      };
      let exit = 1;
      try { exit = await term.execute(line, io); }
      catch (e) { send({ type: 'out', data: `ERROR: unexpected failure: ${e && e.message}\n` }); }
      finally { runs.delete(id); send({ type: 'end', exit }); if (!res.writableEnded) res.end(); }
      return true;
    }

    json(res, 404, { error: 'unknown terminal endpoint' });
    return true;
  }

  return { handle, token, terminal: term };
}

module.exports = { createTerminalHttp };
