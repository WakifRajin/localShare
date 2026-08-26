#!/usr/bin/env node
/**
 * localShare relay server
 * -------------------
 * Zero dependencies — just Node's built-in http/fs/os modules.
 * Open source: https://github.com/WakifRajin/localShare
 *
 * What it does:
 *  1. Serves public/index.html (the localShare app) at http://<this-machine>:8787
 *  2. Runs a tiny rendezvous API so two browsers on the same network can trade
 *     WebRTC connection info using a short 5-character code instead of a huge
 *     pasted blob.
 
 * IMPORTANT: this server never sees your chat, files, or shared text. Once two
 * browsers connect, all of that flows directly between them over WebRTC — this
 * script only helps them find each other, and forgets each code right after
 * it's used (or after 15 minutes, whichever comes first). It never talks to
 * the internet; it only needs to be reachable on your local network.
 
 * Usage:
 *   node server.js            (defaults to port 8787)
 *   PORT=9000 node server.js  (custom port)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
const ROOM_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 2_000_000; // signaling payloads are small; this is a generous ceiling

const rooms = new Map(); // code -> { offer, answer, createdAt }

function genCode(){
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000).unref();

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const p = url.pathname;

    // --- Serve the app ---
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // --- Signaling API ---
    if (p === '/api/create' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body || !body.offer) return sendJSON(res, 400, { error: 'missing offer' });
      const code = genCode();
      rooms.set(code, { offer: body.offer, answer: null, createdAt: Date.now() });
      return sendJSON(res, 200, { code });
    }

    let m = p.match(/^\/api\/offer\/([A-Za-z0-9]{5})$/);
    if (m && req.method === 'GET') {
      const room = rooms.get(m[1].toUpperCase());
      if (!room) return sendJSON(res, 404, { error: 'code not found or expired' });
      return sendJSON(res, 200, { offer: room.offer });
    }

    m = p.match(/^\/api\/answer\/([A-Za-z0-9]{5})$/);
    if (m && req.method === 'POST') {
      const room = rooms.get(m[1].toUpperCase());
      if (!room) return sendJSON(res, 404, { error: 'code not found or expired' });
      const body = JSON.parse(await readBody(req));
      if (!body || !body.answer) return sendJSON(res, 400, { error: 'missing answer' });
      room.answer = body.answer;
      return sendJSON(res, 200, { ok: true });
    }
    if (m && req.method === 'GET') {
      const code = m[1].toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendJSON(res, 404, { error: 'code not found or expired' });
      if (!room.answer) return sendJSON(res, 202, { pending: true });
      const answer = room.answer;
      rooms.delete(code); // single-use: the host has what it needs
      return sendJSON(res, 200, { answer });
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown endpoint' });

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const addrs = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
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
