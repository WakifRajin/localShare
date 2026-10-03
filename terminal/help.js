'use strict';
/** Interactive help. One source of truth: the CLI prints these, and the web terminal embeds the rendered text. */
const { makeStyle, padEnd } = require('./output/terminal');

const W = 30; // command column width

const TOPICS = {
  index: {
    title: 'NETWORK COMMANDS',
    sections: [
      { rows: [
        ['net interfaces', 'Show network interfaces'], ['net routes', 'Show routing table'], ['net neighbors', 'Show ARP/neighbor table'],
        ['net connections', 'Show active connections'], ['net ports', 'Show listening ports'], ['net dns', 'Show DNS configuration'], ['net stats', 'Protocol statistics (TCP retransmits, UDP errors)'], ['route <destination>', 'Which route/source address reaches a destination'],
      ] },
      { rows: [['ping <host>', 'Test connectivity'], ['trace <host>', 'Trace network path'], ['resolve <domain>', 'Perform DNS lookup'], ['tcp <host> <port>', 'Test a TCP connection'], ['udp <host> <port>', 'Probe a UDP port'], ['http <url>', 'HTTP timing: DNS, connect, TLS, TTFB'], ['mtu test <host>', 'Find the path MTU'], ['ethernet <interface>', 'Ethernet link: speed, duplex, negotiation']] },
      { rows: [['scan --local', 'Local interfaces and devices on the LAN'], ['scan <target>', 'Reachability of a host, or a ping sweep of a CIDR'], ['scan --ports <target>', 'TCP connect scan of common ports']] },
      { rows: [['bandwidth server|client|udp', 'iperf3 throughput tests'], ['monitor bandwidth [if]', 'Live RX/TX from interface counters'], ['capture <interface>', 'Packet capture (tcpdump)'], ['security scan|ports|services', 'Authorized auditing (nmap)']] },
      { rows: [['status', 'Privileges, tools and logging state'], ['log start|stop|status', 'Structured diagnostic log'], ['history, !!, !N, alias', 'Command history and aliases'], ['clear, version, exit', '']] },
    ],
    footer: ['Type:', 'help bandwidth', 'for bandwidth testing commands.', '', 'Any command accepts --help, --json, --verbose, --quiet and --yes.'],
  },
  net: {
    title: 'NET COMMANDS',
    sections: [{ rows: [
      ['net interfaces [name]', 'Interfaces: state, addresses, MAC, MTU, link speed, RX/TX counters'], ['net routes [--ipv6]', 'Routing table (destination, gateway, interface, source)'],
      ['route <destination>', 'Route and source address used to reach one destination'], ['net neighbors', 'ARP/neighbor table: IP, MAC, interface, state'],
      ['net connections', 'All sockets  (--tcp --udp --listen --established)'], ['net ports', 'Listening/bound sockets with owning process (--tcp --udp)'],
      ['net dns', 'Resolvers and search domains in use'], ['net stats', 'IP/TCP/UDP/ICMP counters (Linux)'],
    ] }],
    footer: ['Back-ends: `ip -j` and `ss` on Linux, PowerShell on Windows. Unavailable data is shown as N/A, never guessed.'],
  },
  scan: {
    title: 'DISCOVERY COMMANDS',
    sections: [{ rows: [
      ['scan --local', 'Your interfaces plus devices seen in the neighbor table (passive)'], ['scan --local --active', 'ARP-scan the subnet (arp-scan, root; asks first)'],
      ['scan <host>', 'Is it up? RTT, hostname, MAC when on the same subnet'], ['scan <cidr>', 'Ping sweep, e.g. 192.168.1.0/24 (asks first)'],
      ['scan --ports <host>', 'TCP connect scan of ~40 common ports'], ['scan --ports <host> --range 1-1024', 'Choose the ports (asks above 100 ports)'],
    ] }],
    footer: ['Nothing aggressive runs without a confirmation. For service/version detection use `help security`.'],
  },
  bandwidth: {
    title: 'BANDWIDTH COMMANDS',
    sections: [{ rows: [
      ['bandwidth server', 'Start an iperf3 server on this host (Ctrl+C to stop)'], ['bandwidth client <host>', 'TCP throughput to a server'],
      ['  --duration <s> --streams <n>', 'Test length / parallel streams'], ['  --reverse', 'Measure the other direction'], ['bandwidth udp <host> --rate 100M', 'UDP throughput, jitter and loss'],
      ['monitor bandwidth [iface]', 'Live RX/TX rates from system counters (--interval <s>)'],
    ] }],
    footer: ['Needs iperf3 on both ends. LINK SPEED is the negotiated capacity; THROUGHPUT is what was measured.'],
  },
  capture: {
    title: 'CAPTURE',
    sections: [{ rows: [
      ['capture <interface>', 'Live packet summaries (needs tcpdump and privileges)'], ['  --host <ip>  --port <n>', 'Filter by host / port'], ['  --tcp  --udp', 'Filter by protocol'],
      ['  --count <n>', 'Stop after n packets'], ['  --output <file.pcap>', 'Save a pcap for Wireshark'],
    ] }],
    footer: ['A notice and confirmation always precede a capture. Ctrl+C stops it cleanly.'],
  },
  security: {
    title: 'SECURITY AUDITING (authorized targets only)',
    sections: [{ rows: [
      ['security scan <target>', 'Host discovery + top 100 TCP ports (nmap)'], ['security ports <target> [--range ...|--all]', 'Port scan of a chosen range'],
      ['security services <target>', 'Service/version detection (-sV)'], ['  --scripts', "nmap's default scripts (-sC); more intrusive"], ['  --os', 'OS detection (-O); needs root'],
    ] }],
    footer: ['Targets must be private addresses unless you add --authorized. Every scan asks for confirmation first.', 'This tool does discovery and identification only — no exploitation, credential attacks or denial-of-service.'],
  },
  diagnostics: {
    title: 'DIAGNOSTICS',
    sections: [{ rows: [
      ['ping <host> [-c n] [--interval s] [--size b]', 'RTT, loss, min/avg/max/stddev'], ['trace <host>', 'Hop-by-hop path (traceroute / tracepath / tracert)'], ['resolve <domain> [--type MX] [--server ip]', 'A, AAAA, CNAME, MX, TXT, NS'],
      ['tcp <host> <port>', 'SUCCESS / REFUSED / TIMEOUT (timeout is not "closed")'], ['udp <host> <port> [--data text]', 'RESPONSE / REFUSED / NO RESPONSE'], ['http <url> [--insecure]', 'DNS, connect, TLS, TTFB, total, size'],
      ['mtu test <host>', 'Largest unfragmented payload'], ['ethernet <interface>', 'Link state, speed, duplex, advertised modes'],
    ] }],
    footer: [],
  },
};
// Aliases so `help ping`, `help monitor`, etc. land somewhere useful.
const ALIASES = { ping: 'diagnostics', trace: 'diagnostics', resolve: 'diagnostics', tcp: 'diagnostics', udp: 'diagnostics', http: 'diagnostics', mtu: 'diagnostics', ethernet: 'diagnostics', diag: 'diagnostics', monitor: 'bandwidth', route: 'net', discovery: 'scan' };

function render(topic, style) {
  const key = TOPICS[topic] ? topic : ALIASES[topic];
  const t = TOPICS[key];
  if (!t) return null;
  const out = [style.head(t.title), ''];
  for (const sec of t.sections) {
    for (const [cmd, desc] of sec.rows) out.push(desc ? `${padEnd(cmd, W)}${desc}` : cmd);
    out.push('');
  }
  if (t.footer.length) out.push(...t.footer.map((l, i, a) => (/^help /.test(l) ? style.cyan(l) : l)), '');
  return out.join('\n');
}

/** Rendered text for `help [topic]`; unknown topics fall back to the index with a note. */
function helpText(topic, color = true) {
  const st = makeStyle(color);
  const t = (topic || 'index').toLowerCase();
  const text = render(t, st);
  if (text) return text;
  return `${st.warn(`No help topic '${topic}'.`)} Topics: ${Object.keys(TOPICS).filter(k => k !== 'index').join(', ')}\n\n${render('index', st)}`;
}

const topicNames = () => ['index', ...Object.keys(TOPICS).filter(k => k !== 'index'), ...Object.keys(ALIASES)];

module.exports = { helpText, topicNames, TOPICS };
