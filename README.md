# localShare | local mesh workspace

Chat, a live shared document, and file transfer between devices — peer to peer
over WebRTC. No accounts, no cloud storage: once two browsers are connected,
everything flows directly between them.

**Try it now:** https://wakifrajin.github.io/localShare/

## How joining works

1. The host picks a name and chooses **Host a session**. They get a **QR code**,
   a 5-character code, and an invite link.
2. Everyone else scans the QR code with their phone camera (or opens the link, or
   types the code). They pick a name and they're in. No copy-pasting.
3. The host can invite more people at any time with **Invite** — each invite
   gets a fresh code.

## Three ways the code gets exchanged

localShare picks the best one automatically:

| Mode | When | What's used |
| --- | --- | --- |
| **Local relay** | you run `node server.js` | your own machine, fully offline |
| **Online** | the hosted site, or any copy of `docs/index.html` with internet | public [ntfy.sh](https://ntfy.sh) topics + Google/Cloudflare STUN, so it works across networks |
| **Offline pairing** | nothing else is reachable | copy & paste a code each way (also works from `file://`) |

In every mode only the small WebRTC connection descriptions are exchanged
(no chat, files or text). In **online** mode that info goes via ntfy.sh and your
public IP is visible to the STUN servers; use the local relay if you'd rather
keep everything on your own network. Direct connections can fail on very strict
networks (e.g. some mobile data / corporate Wi-Fi) since no TURN server is used.

## Local relay (fully offline)

Requires [Node.js](https://nodejs.org) on **one** machine; others just need a browser.

```
node server.js
```

```
On this machine:  http://localhost:8787
On your network:  http://192.168.1.42:8787
```

Open the page, host a session, and share the QR code. The QR always points at
your LAN address (not `localhost`), so phones can open it. `server.js` has zero
dependencies, never makes an outbound request, hands out a code, keeps the
connection info for up to 15 minutes, and forgets it once it's used. Failed code
lookups are rate-limited.

## Hosting on GitHub Pages

The whole app is the static file `docs/index.html`: **Settings → Pages → Deploy
from a branch → `main` → `/docs`**. It runs in *online* mode there.

## Features

- Live chat with unread badges, shared document, drag-and-drop file transfer
  (binary chunks, any number of participants), and a small shared terminal.
- The host relays between participants, so everyone sees the same roster, and
  joins/leaves are announced.
- Dark and light themes; works on phones (tab bar layout).

## Files

- `server.js` — the optional local relay + static file server
- `docs/index.html` — the app itself (includes an inlined MIT-licensed
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) for the QR code)
