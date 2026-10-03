#!/usr/bin/env node
/**
 * localShare relay server
 * -------------------
 * Zero dependencies — just Node's built-in http/fs/os/crypto modules.
 * Open source: https://github.com/WakifRajin/localShare
 *
 * What it does:
 *  1. Serves docs/index.html (the localShare app) at http://<this-machine>:8787
 *  2. Runs a tiny rendezvous API so two browsers on the same network can trade
 *     WebRTC connection info using a short 5-character code instead of a huge
 *     pasted blob.
 *
 * IMPORTANT: this server never sees your chat, files, or shared text. Once two
 * browsers connect, all of that flows directly between them over WebRTC — this
 * script only helps them find each other, and forgets each code right after
 * it's used (or after 15 minutes, whichever comes first). It never talks to
 * the internet; it only needs to be reachable on your local network.
 *
 * Usage:
 *   node server.js            (defaults to port 8787)
 *   PORT=9000 node server.js  (custom port)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const APP_DIR = path.join(__dirname, 'docs');
const INDEX_FILE = path.join(APP_DIR, 'index.html');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
const ROOM_TTL_MS = 15 * 60 * 1000;
const MAX_ROOMS = 500;
const MAX_BODY_BYTES = 200_000;     // an SDP blob is a few KB; this is a generous ceiling
const LOOKUP_LIMIT = 40;            // failed code lookups allowed per IP per window
const LOOKUP_WINDOW_MS = 60 * 1000;

const rooms = new Map();    // code -> { offer, answer, createdAt }
const failures = new Map(); // ip -> { count, resetAt }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function genCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  for (const [ip, f] of failures) if (now > f.resetAt) failures.delete(ip);
}, 60 * 1000).unref();

// Throttle code guessing: only *failed* lookups count, so normal use is never affected.
function lookupBlocked(ip) {
  const f = failures.get(ip);
  return !!f && Date.now() <= f.resetAt && f.count >= LOOKUP_LIMIT;
}
function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now > f.resetAt) failures.set(ip, { count: 1, resetAt: now + LOOKUP_WINDOW_MS });
  else f.count++;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload too large'));
        req.resume(); // drain instead of destroying, so the 413 can still be delivered
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function isSessionDescription(d, type) {
  return !!d && typeof d === 'object' && d.type === type && typeof d.sdp === 'string' && d.sdp.length > 0;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;
    const ip = req.socket.remoteAddress || 'unknown';

    // --- Serve the app ---
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }

    // --- Signaling API ---
    if (p === '/api/ping' && req.method === 'GET') {
      return sendJSON(res, 200, { app: 'localshare', ok: true });
    }

    if (p === '/api/create' && req.method === 'POST') {
      const body = await readJSON(req);
      if (!body || !isSessionDescription(body.offer, 'offer')) throw new HttpError(400, 'missing or invalid offer');
      if (rooms.size >= MAX_ROOMS) throw new HttpError(429, 'too many open sessions — try again shortly');
      const code = genCode();
      rooms.set(code, { offer: body.offer, answer: null, createdAt: Date.now() });
      return sendJSON(res, 200, { code });
    }

    let m = p.match(/^\/api\/offer\/([A-Za-z0-9]{5})$/);
    if (m && req.method === 'GET') {
      if (lookupBlocked(ip)) throw new HttpError(429, 'too many attempts — wait a minute');
      const room = rooms.get(m[1].toUpperCase());
      if (!room) { noteFailure(ip); throw new HttpError(404, 'code not found or expired'); }
      return sendJSON(res, 200, { offer: room.offer });
    }

    m = p.match(/^\/api\/answer\/([A-Za-z0-9]{5})$/);
    if (m && req.method === 'POST') {
      if (lookupBlocked(ip)) throw new HttpError(429, 'too many attempts — wait a minute');
      const room = rooms.get(m[1].toUpperCase());
      if (!room) { noteFailure(ip); throw new HttpError(404, 'code not found or expired'); }
      const body = await readJSON(req);
      if (!body || !isSessionDescription(body.answer, 'answer')) throw new HttpError(400, 'missing or invalid answer');
      if (room.answer) throw new HttpError(409, 'this code was already used'); // first joiner wins
      room.answer = body.answer;
      return sendJSON(res, 200, { ok: true });
    }
    if (m && req.method === 'GET') {
      const code = m[1].toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new HttpError(404, 'code not found or expired');
      if (!room.answer) return sendJSON(res, 202, { pending: true });
      const answer = room.answer;
      rooms.delete(code); // single-use: the host has what it needs
      return sendJSON(res, 200, { answer });
    }

    if (p.startsWith('/api/')) throw new HttpError(404, 'unknown endpoint');

    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    if (res.headersSent) return res.end();
    sendJSON(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'internal error' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or pick another port, e.g.  PORT=9000 node server.js`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const addrs = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('localShare relay is running.\n');
  console.log(`  On this machine:  http://localhost:${PORT}`);
  if (addrs.length) {
    addrs.forEach(a => console.log(`  On your network:  http://${a}:${PORT}`));
    console.log('\nShare one of the "On your network" links with others on the same Wi-Fi/LAN.');
    console.log('They open it in a browser, choose "Join a session", and type the 5-character code.');
  } else {
    console.log('\nNo local network address detected — others may need the machine\'s LAN IP manually.');
  }
  console.log('\nThis server only helps devices find each other. Chat, files, and shared text never pass through it.');
  console.log('Press Ctrl+C to stop.');
});

process.on('SIGINT', () => { console.log('\nStopped.'); process.exit(0); });
