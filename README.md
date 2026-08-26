# localShare | local mesh workspace

Chat, a live shared text doc, and file transfer between devices on the same
network. No internet, no accounts, no cloud service — devices talk directly
over WebRTC once connected.

## Quick start (short 5-character codes)

Requires [Node.js](https://nodejs.org) (any recent version) on **one** machine
— the others just need a browser.

```
node server.js
```

You'll see something like:

```
On this machine:  http://localhost:8787
On your network:  http://192.168.1.42:8787
```

1. Open the "On your network" link yourself, pick a name, choose **Host a
   session** — you'll get a 5-character code.
2. Everyone else on the same Wi‑Fi/LAN opens that same link in their browser,
   chooses **Join a session**, and types the code in.
3. That's it — chat, the shared text tab, and file drops all sync live.

The host can invite more people at any time with the **➕ Invite** button —
each invite gets its own fresh code.

### What the server does (and doesn't do)

`server.js` only helps two browsers find each other — it hands out a short
code, holds onto the connection info for a few minutes, and forgets it the
moment it's used (or after 15 minutes, whichever is first). Once connected,
chat messages, the shared text, and files travel directly between browsers
and never pass through the server. It has zero dependencies (just Node's
built-ins) and never makes an outbound request — it only needs to be
reachable on your local network, not the internet.

## No Node available? Use manual codes instead

You can also just open `public/index.html` directly in a browser (double-click
it) on each device — no server needed at all. In that case, or if the relay
isn't reachable for some reason, the app automatically offers a "Use a manual
code instead" link: the host copies a longer connection code and sends it to
the joiner by any means (chat app, AirDrop, USB stick), and the joiner pastes
back a short reply code to finish connecting. It's more copy-pasting, but
still fully serverless.

## Files

- `server.js` — the relay + static file server (`node server.js`)
- `public/index.html` — the app itself
