# localShare | local mesh workspace

Chat, a live shared document, and file transfer between devices — peer to peer
over WebRTC. No accounts, no cloud storage: once two browsers are connected,
everything flows directly between them.

**Try it now:** https://wakifrajin.github.io/localShare/

## How joining works

**Nearby devices (like PairDrop)** — open the site on two devices on the same
Wi-Fi. Each shows up on the other automatically; tap one, the other taps
**Accept**, and you're connected. Anyone else on the network can then connect to
the host the same way.

**Codes, QR and links** — for people who aren't on your network, the host picks
**Host with a code** and shares the QR code, the 5-character code, or the invite
link. Scanning or opening the link asks only for a name and joins automatically.

## Three ways the code gets exchanged

localShare picks the best one automatically:

| Mode | When | What's used |
| --- | --- | --- |
| **Local relay** | you run `node server.js` | your own machine, fully offline |
| **Online** | the hosted site, or any copy of `docs/index.html` with internet | public [ntfy.sh](https://ntfy.sh) topics + Google/Cloudflare STUN, so it works across networks |
| **Offline pairing** | nothing else is reachable | copy & paste a code each way (also works from `file://`) |

### How nearby discovery works (no server of ours)

Devices behind the same router share a public IP. Each device asks a STUN server
for its public IPv4, hashes it into a room name, and meets the others on public
MQTT-over-WebSocket brokers (HiveMQ, EMQX, Mosquitto — several at once for
reliability). Everything on the brokers is AES-GCM encrypted with a key derived
from that IP, so they only see noise, and only presence and the WebRTC handshake
travel that way — never chat, files or text. Anyone on the same public IP (e.g. a
cafe's Wi-Fi) can see your device name and send a request, but nothing connects
until you accept. Discovery works on the hosted site and any copy served over
HTTPS or `localhost`; it needs internet access (the local relay mode skips it).

### Privacy notes

In **online** mode the small connection descriptions go through public services
(ntfy.sh for codes, the MQTT brokers for nearby discovery) and your public IP is
visible to the STUN servers. Use the local relay if you'd rather keep everything
on your own network. Direct connections can fail on very strict networks (some
mobile data / corporate Wi-Fi) since no TURN server is used.

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
