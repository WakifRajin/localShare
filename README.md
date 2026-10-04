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

**Talk**
- Chat with delivery confirmation, unread badges, typing indicators, search and
  export (.txt / .json). Messages support `**bold**`, `` `code` ``, fenced code
  blocks, links (http/https only — everything else stays plain text) and
  `@mentions` that highlight and notify the person mentioned.
- **Paste, drop or attach images** and they appear inline in the chat (click to
  enlarge). **Share your clipboard** with one click as a copyable card.
- Optional message sound and desktop notifications; rename yourself any time.

**Share**
- Drag-and-drop (or paste) files anywhere in the app. Send to everyone or to
  **one person** — addressed transfers are forwarded only to the recipient.
  Live speed and time remaining, cancel mid-transfer, image thumbnails, *Save
  all* and *Clear finished*.
- **Shared document** that merges simultaneous edits instead of overwriting
  them, with Markdown preview, word/line counts, adjustable text size, and
  Open / Save to move text in and out.
- **Whiteboard**: pen, eraser, colours, sizes, undo, clear and PNG export;
  strokes stream live and late joiners get the existing drawing.

**Stay connected**
- **Self-healing connections:** if a device's link drops (phone slept, Wi-Fi
  hiccup) it reconnects on its own through a private encrypted room named after
  the session; unsent messages are resent and missed chat is replayed. Phones
  keep the screen awake during a session.
- Live round-trip time to every directly connected device.

**Everyday polish**
- **Command palette** (`Ctrl+K`) and keyboard shortcuts (`?` lists them).
- **Installable offline app** (PWA): add it to your home screen or desktop, and
  it opens even without a network.
- Settings for theme (system / dark / light), compact layout, sounds and
  notifications; dark and light themes; works on phones (tab bar layout).
- A real **network diagnostics terminal** (below).

## Network terminal

An engineering-focused terminal for inspecting and debugging local networks —
Ethernet links, switches, Jetsons, cameras, ROS 2 and telemetry links. It runs
**real system commands** and never fabricates results: anything it can't obtain
is reported as `N/A`, `UNAVAILABLE` or `PERMISSION REQUIRED`.

```
node server.js            # then open http://localhost:8787 on that machine → Terminal tab
node terminal/cli.js      # the same terminal in a shell (works over SSH)
node terminal/cli.js ping 192.168.1.1 --json    # one-shot, scriptable, exit status = command status
```

| Area | Commands |
| --- | --- |
| Inspection | `net interfaces` `net routes` `route <dest>` `net neighbors` `net connections` `net ports` `net dns` `net stats` |
| Connectivity | `ping` `trace` `resolve` `tcp <host> <port>` `udp` `http <url>` `mtu test <host>` `ethernet <if>` |
| Discovery | `scan --local` `scan <host\|cidr>` `scan --ports <host>` |
| Throughput | `bandwidth server\|client\|udp` (iperf3), `monitor bandwidth [if]` (live, from kernel counters) |
| Capture | `capture <if> [--host --port --tcp --udp --output x.pcap]` (tcpdump) |
| Security | `security scan\|ports\|services <target>` (nmap, authorized/private targets) |
| Session | `help [topic]` `status` `log start\|stop\|status` `history` `!!` `!N` `alias` `clear` |

Every command takes `--help`, `--json` (pure JSON, no ANSI), `--verbose`,
`--quiet` and `--yes`. `Ctrl+C` cancels the running operation cleanly.

**Back-ends.** Linux is the primary target: `ip -j`, `ss`, `ethtool`, `/sys` and
`/proc` counters, `tcpdump`, `iperf3`, `nmap`. Windows supports the inspection,
connectivity, discovery and monitoring commands through PowerShell and the
built-in tools; capture and `ethtool`-level detail need Linux. `status` shows
what's installed; missing optional tools never block startup.

**Accuracy rules.** A `tcp` timeout is *not* reported as "closed" (only a RST
is). `LINK SPEED` is the negotiated capacity and is never presented as measured
throughput; `bandwidth` reports link speed, per-direction iperf3 throughput and
retransmits/loss separately. UDP probes say plainly that silence is ambiguous.

**Safety.**
- Commands run without a shell (argv arrays only); targets, ports and interface
  names are validated, so nothing can be smuggled in as an option.
- Intrusive operations (subnet sweeps, bandwidth tests, captures, every security
  scan) ask for confirmation first; packet capture always shows a notice.
- Security commands are discovery and identification only, limited to private
  addresses unless you pass `--authorized`, and they offer no exploitation,
  credential attacks, evasion or denial-of-service features.
- The in-app terminal only works for the person at the machine running
  `server.js`: it accepts loopback connections only, checks the `Host` and
  `Origin` headers, and requires a per-run secret token, so other devices on the
  network, other websites and joined participants cannot run commands. Start the
  server with `--no-terminal` to disable it. (On the hosted site there is no
  agent, so network commands report `UNAVAILABLE`.)
- `log start` writes JSON Lines (timestamp, command, target, result, duration,
  exit status) to `~/.localshare/logs/`; credentials are redacted, and history
  never stores lines that look like they contain secrets.

```
npm test          # parsers (Linux/macOS/Windows output), safety guards, pipeline, HTTP bridge
```

## Files

- `server.js` — the optional local relay, static file server and terminal bridge
- `terminal/` — the diagnostics terminal: `parser`, `commands/{network,discovery,bandwidth,capture,diagnostics,security}`,
  `system/{command_runner,platform,permissions,validate}`, `output/{terminal,json,tables}`,
  `monitoring/`, `logging/`, `config.js`, `cli.js`, and the HTTP bridge
- `docs/index.html` — the app itself (includes an inlined MIT-licensed
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) for the QR code);
  after changing help text run `node terminal/build-web.js`
- `docs/sw.js`, `docs/manifest.webmanifest`, `docs/icon*.{svg,png}` — the installable offline app
  (regenerate the PNGs with `node scripts/make-icons.js`)
- `test/` and `terminal/test/` — `npm test` runs everything: terminal parsers and safety guards,
  the page's pure logic (rich text, Markdown, merge), service-worker rules and static-file safety
