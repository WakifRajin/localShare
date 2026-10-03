'use strict';
/** Linux/macOS back-ends can't be executed on every dev machine, so their parsers are tested against captured output. */
const test = require('node:test');
const assert = require('node:assert/strict');

const network = require('../commands/network').parsers;
const counters = require('../monitoring/counters');
const diag = require('../commands/diagnostics').parsers;
const bw = require('../commands/bandwidth').parsers;
const cap = require('../commands/capture').parsers;
const sec = require('../commands/security').parsers;
const disc = require('../commands/discovery').parsers;

/* ------------------------------------------------------------------ ip -j */

const IP_ADDR = [
  { ifindex: 1, ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], mtu: 65536, operstate: 'UNKNOWN', link_type: 'loopback', address: '00:00:00:00:00:00', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }, { family: 'inet6', local: '::1', prefixlen: 128 }] },
  { ifindex: 2, ifname: 'eth0', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', address: 'aa:bb:cc:dd:ee:01', addr_info: [{ family: 'inet', local: '192.168.1.12', prefixlen: 24 }, { family: 'inet6', local: 'fe80::a8bb:ccff:fedd:ee01', prefixlen: 64 }] },
  { ifindex: 3, ifname: 'wlan0', flags: ['BROADCAST', 'MULTICAST', 'UP'], mtu: 1500, operstate: 'DOWN', link_type: 'ether', address: 'aa:bb:cc:dd:ee:02', addr_info: [] },
  { ifindex: 4, ifname: 'veth1', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mtu: 1500, operstate: 'UP', link_type: 'ether', address: 'aa:bb:cc:dd:ee:03', addr_info: [] },
];
const IP_LINK = [
  { ifname: 'lo', stats64: { rx: { bytes: 100, packets: 2, errors: 0, dropped: 0 }, tx: { bytes: 100, packets: 2, errors: 0, dropped: 0 } } },
  { ifname: 'eth0', stats64: { rx: { bytes: 8410000000, packets: 8193221, errors: 3, dropped: 1 }, tx: { bytes: 2130000000, packets: 4912332, errors: 0, dropped: 0 } } },
  { ifname: 'veth1', linkinfo: { info_kind: 'veth' }, stats64: { rx: { bytes: 1, packets: 1, errors: 0, dropped: 0 }, tx: { bytes: 1, packets: 1, errors: 0, dropped: 0 } } },
];

test('ip -j: interfaces, state, addresses, counters, link speed', () => {
  const sys = (name, f) => (name === 'eth0' && f === 'speed' ? '1000' : name === 'wlan0' && f === 'speed' ? '-1' : null);
  const r = counters.parseIpJson(IP_ADDR, IP_LINK, { sys });
  const by = Object.fromEntries(r.map(i => [i.name, i]));
  assert.equal(by.lo.type, 'loopback'); assert.equal(by.lo.state, 'UP'); assert.equal(by.lo.mac, null);
  assert.equal(by.eth0.type, 'ethernet'); assert.equal(by.eth0.state, 'UP');
  assert.deepEqual(by.eth0.ipv4, ['192.168.1.12/24']);
  assert.equal(by.eth0.mac, 'aa:bb:cc:dd:ee:01'); assert.equal(by.eth0.mtu, 1500); assert.equal(by.eth0.speedMbps, 1000);
  assert.deepEqual(by.eth0.rx, { bytes: 8410000000, packets: 8193221, errors: 3, dropped: 1 });
  assert.equal(by.wlan0.state, 'DOWN'); assert.equal(by.wlan0.speedMbps, null);           // -1 means "unknown", never shown as a speed
  assert.equal(by.wlan0.rx.bytes, null);                                                   // no counters -> null (N/A), not 0
  assert.equal(by.veth1.type, 'veth');
});

test('ip -j route / route get / neigh', () => {
  const routes = network.parseRoutesJson([
    { dst: 'default', gateway: '192.168.1.1', dev: 'eth0', prefsrc: '192.168.1.12', metric: 100, protocol: 'dhcp' },
    { dst: '192.168.1.0/24', dev: 'eth0', scope: 'link', prefsrc: '192.168.1.12', metric: 100, protocol: 'kernel' },
  ]);
  assert.deepEqual(routes.map(r => [r.destination, r.gateway, r.interface, r.source]), [['default', '192.168.1.1', 'eth0', '192.168.1.12'], ['192.168.1.0/24', 'direct', 'eth0', '192.168.1.12']]);
  const get = network.parseRoutesJson([{ dst: '192.168.1.20', dev: 'eth0', prefsrc: '192.168.1.12', uid: 1000 }]);
  assert.equal(get[0].gateway, 'direct');
  const neigh = network.parseNeighJson([{ dst: '192.168.1.1', dev: 'eth0', lladdr: 'aa:aa:aa:aa:aa:01', state: ['REACHABLE'] }, { dst: '192.168.1.20', dev: 'eth0', state: ['FAILED'] }]);
  assert.deepEqual(neigh[0], { ip: '192.168.1.1', mac: 'aa:aa:aa:aa:aa:01', interface: 'eth0', state: 'REACHABLE' });
  assert.equal(neigh[1].mac, null);
});

/* ------------------------------------------------------------------ ss / netstat / snmp */

const SS = `Netid State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process
tcp   LISTEN 0      128           0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=812,fd=3))
tcp   ESTAB  0      0        192.168.1.12:5000  192.168.1.20:42133 users:(("app",pid=2001,fd=7))
udp   UNCONN 0      0             0.0.0.0:5353        0.0.0.0:*
tcp   LISTEN 0      4096             [::]:8787           [::]:*     users:(("node",pid=33,fd=18))
udp   UNCONN 0      0                   *:68                *:*
tcp   TIME-WAIT 0   0        192.168.1.12:40000  93.184.216.34:443`;

test('ss output', () => {
  const r = network.parseSs(SS);
  assert.equal(r.length, 6);
  assert.deepEqual(r[0], { proto: 'TCP', state: 'LISTEN', local: '0.0.0.0:22', remote: '0.0.0.0:*', process: 'sshd', pid: 812, recvQ: 0, sendQ: 128 });
  assert.equal(r[1].state, 'ESTABLISHED'); assert.equal(r[1].process, 'app');
  assert.equal(r[2].state, '-'); assert.equal(r[2].process, null);        // UDP: no state, no process -> "-"
  assert.equal(r[3].local, '[::]:8787');
  assert.equal(r[4].local, '0.0.0.0:68');                                  // "*:68" normalised
  assert.equal(r[5].state, 'TIME_WAIT');
});

test('windows netstat + tasklist', () => {
  const names = network.parseTasklist('"svchost.exe","1068","Services","0","10,000 K"\n"node.exe","4242","Console","1","40,000 K"\n');
  const rows = network.parseNetstatWin(`Active Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1068\n  TCP    127.0.0.1:8787         127.0.0.1:50000        ESTABLISHED     4242\n  UDP    0.0.0.0:5353           *:*                                    4242\n`, names);
  assert.deepEqual(rows.map(r => [r.proto, r.state, r.local, r.process]), [['TCP', 'LISTEN', '0.0.0.0:135', 'svchost.exe'], ['TCP', 'ESTABLISHED', '127.0.0.1:8787', 'node.exe'], ['UDP', '-', '0.0.0.0:5353', 'node.exe']]);
});

test('/proc/net/snmp', () => {
  const r = network.parseSnmp(`Ip: Forwarding DefaultTTL InReceives OutRequests\nIp: 1 64 5000 4000\nTcp: ActiveOpens PassiveOpens CurrEstab InSegs OutSegs RetransSegs\nTcp: 10 5 3 9000 8000 80\nUdp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors\nUdp: 700 2 1 650 4\n`);
  assert.equal(r.Ip.InReceives, 5000); assert.equal(r.Tcp.RetransSegs, 80); assert.equal(r.Udp.RcvbufErrors, 4);
});

test('resolvectl dns, arp -an, arp-scan', () => {
  assert.deepEqual(network.parseResolvectlDns('Global: 1.1.1.1\nLink 2 (eth0): 192.168.1.1 fe80::1\nLink 3 (wlan0):\n'), [{ interface: 'global', servers: ['1.1.1.1'] }, { interface: 'eth0', servers: ['192.168.1.1', 'fe80::1'] }]);
  assert.deepEqual(network.parseArpAn('? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\n').map(r => [r.ip, r.mac, r.state]), [['192.168.1.1', 'aa:bb:cc:dd:ee:ff', 'REACHABLE'], ['192.168.1.9', null, 'INCOMPLETE']]);
  assert.deepEqual(disc.parseArpScan('Interface: eth0\n192.168.1.1\taa:bb:cc:dd:ee:ff\tTP-LINK TECHNOLOGIES\n192.168.1.20\t00:04:4b:11:22:33\tNVIDIA\n2 packets received\n'), [{ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff', vendor: 'TP-LINK TECHNOLOGIES' }, { ip: '192.168.1.20', mac: '00:04:4b:11:22:33', vendor: 'NVIDIA' }]);
});

/* ------------------------------------------------------------------ ping / trace */

test('ping lines (linux, mac, windows) and summary', () => {
  assert.deepEqual(diag.parsePingLine('64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.82 ms', 'unix'), { seq: 1, rtt: 0.82 });
  assert.deepEqual(diag.parsePingLine('64 bytes from 10.0.0.1: icmp_seq=12 ttl=63 time=12.4 ms', 'unix'), { seq: 12, rtt: 12.4 });
  assert.equal(diag.parsePingLine('From 192.168.1.5 icmp_seq=1 Destination Host Unreachable', 'unix').status, 'unreachable');
  assert.equal(diag.parsePingLine('Request timeout for icmp_seq 3', 'unix').status, 'timeout');
  assert.equal(diag.parsePingLine('PING 192.168.1.1 (192.168.1.1) 56(84) bytes of data.', 'unix'), null);
  assert.deepEqual(diag.parsePingLine('Reply from 192.168.0.1: bytes=32 time=3ms TTL=64', 'windows', 1), { seq: 1, rtt: 3, approx: false, from: '192.168.0.1' });
  assert.equal(diag.parsePingLine('Reply from 127.0.0.1: bytes=32 time<1ms TTL=128', 'windows', 2).approx, true);
  assert.equal(diag.parsePingLine('Request timed out.', 'windows', 3).status, 'timeout');
  assert.deepEqual(diag.parsePingSummary('--- 1.1.1.1 ping statistics ---\n10 packets transmitted, 9 received, 10% packet loss, time 9012ms'), { sent: 10, received: 9, lossPct: 10 });
  assert.deepEqual(diag.parsePingSummary('    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),'), { sent: 4, received: 3, lossPct: 25 });
});

test('ping statistics', () => {
  const s = diag.stats([1, 2, 3, 4]);
  assert.equal(s.min, 1); assert.equal(s.max, 4); assert.equal(s.avg, 2.5); assert.ok(Math.abs(s.stddev - 1.118) < 0.001);
  assert.deepEqual(diag.stats([]), { min: null, avg: null, max: null, stddev: null });   // no replies -> N/A, not zeros
});

test('traceroute / tracepath / tracert lines', () => {
  assert.deepEqual(diag.parseTraceLine(' 1  192.168.1.1  0.512 ms  0.480 ms  0.466 ms', 'traceroute'), { hop: 1, ips: ['192.168.1.1'], rtts: [0.512, 0.48, 0.466], timeout: false });
  assert.deepEqual(diag.parseTraceLine(' 2  * * *', 'traceroute'), { hop: 2, ips: [], rtts: [], timeout: true });
  const multi = diag.parseTraceLine(' 3  10.0.0.1  1.2 ms  10.0.0.2  1.5 ms  10.0.0.1  1.1 ms', 'traceroute');
  assert.deepEqual(multi.ips, ['10.0.0.1', '10.0.0.2']);
  assert.equal(diag.parseTraceLine('traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets', 'traceroute'), null);
  assert.deepEqual(diag.parseTraceLine(' 1:  192.168.1.1                                         0.512ms', 'tracepath'), { hop: 1, ips: ['192.168.1.1'], rtts: [0.512], timeout: false });
  assert.equal(diag.parseTraceLine(' 2:  no reply', 'tracepath').timeout, true);
  assert.deepEqual(diag.parseTraceLine('  1    <1 ms    <1 ms    <1 ms  192.168.0.1', 'tracert'), { hop: 1, ips: ['192.168.0.1'], rtts: [1, 1, 1], timeout: false });
  assert.equal(diag.parseTraceLine('  2     *        *        *     Request timed out.', 'tracert').timeout, true);
});

test('MTU search finds the exact boundary', async () => {
  for (const mtu of [1472, 1400, 1280, 576, 56]) {
    let probes = 0;
    const best = await diag.searchLargest(async n => { probes++; return n <= mtu; }, 56, 1471);
    assert.equal(best, Math.min(mtu, 1471));
    assert.ok(probes <= 12);
  }
});

/* ------------------------------------------------------------------ ethtool */

const ETHTOOL = `Settings for eth0:
\tSupported ports: [ TP MII ]
\tSupported link modes:   10baseT/Half 10baseT/Full
\t                        100baseT/Half 100baseT/Full
\t                        1000baseT/Full
\t                        2500baseT/Full
\tSupported pause frame use: Symmetric Receive-only
\tSupports auto-negotiation: Yes
\tAdvertised link modes:  10baseT/Half 10baseT/Full
\t                        100baseT/Half 100baseT/Full
\t                        1000baseT/Full
\tAdvertised auto-negotiation: Yes
\tLink partner advertised link modes:  100baseT/Full
\tSpeed: 100Mb/s
\tDuplex: Full
\tAuto-negotiation: on
\tPort: Twisted Pair
\tMDI-X: off (auto)
\tLink detected: yes
`;

test('ethtool', () => {
  const e = diag.parseEthtool(ETHTOOL);
  assert.equal(e.Speed, '100Mb/s'); assert.equal(e.Duplex, 'Full'); assert.equal(e['Auto-negotiation'], 'on'); assert.equal(e['Link detected'], 'yes'); assert.equal(e.Port, 'Twisted Pair');
  const sup = diag.modesToSpeeds(e['Supported link modes']);
  assert.deepEqual(sup.map(s => s.mbps), [10, 100, 1000, 2500]);
  assert.deepEqual(sup[1].duplex, ['Half', 'Full']); assert.deepEqual(sup[3].duplex, ['Full']);
  assert.deepEqual(diag.modesToSpeeds(e['Advertised link modes']).map(s => s.mbps), [10, 100, 1000]);   // advertises gigabit but negotiated 100 -> the cable diagnostic
  assert.deepEqual(diag.modesToSpeeds(e['Link partner advertised link modes']).map(s => s.mbps), [100]);
});

/* ------------------------------------------------------------------ iperf3 */

const IPERF_TCP = { start: { test_start: { protocol: 'TCP', num_streams: 4, duration: 10, reverse: 0, blksize: 131072 } }, end: { sum_sent: { bytes: 1257000000, bits_per_second: 1005000000, retransmits: 42 }, sum_received: { bytes: 1255000000, bits_per_second: 998000000 } } };
const IPERF_UDP = { start: { test_start: { protocol: 'UDP', num_streams: 1, duration: 10, reverse: 0, target_bitrate: 100000000 } }, end: { sum: { bytes: 123731968, bits_per_second: 99000000, jitter_ms: 0.41, lost_packets: 2, packets: 9000, lost_percent: 0.02 } } };

test('iperf3 JSON', () => {
  const t = bw.parseIperf(IPERF_TCP);
  assert.equal(t.protocol, 'TCP'); assert.equal(t.streams, 4); assert.equal(t.retransmits, 42);
  assert.equal(t.sender.bitsPerSecond, 1005000000); assert.equal(t.receiver.bitsPerSecond, 998000000);
  assert.equal(t.bitsPerSecond, 998000000);                                // headline number is what the receiver actually got
  const u = bw.parseIperf(IPERF_UDP);
  assert.equal(u.protocol, 'UDP'); assert.equal(u.jitterMs, 0.41); assert.equal(u.lossPercent, 0.02); assert.equal(u.lostPackets, 2);
  assert.throws(() => bw.parseIperf({ error: 'unable to connect to server: Connection refused' }), e => e.code === 'UNREACHABLE');
  assert.throws(() => bw.parseIperf({ error: 'unable to connect to server: Connection timed out' }), e => e.code === 'TIMEOUT');
  assert.throws(() => bw.parseIperf({ error: 'the server is busy running a test. try again later' }), e => e.code === 'FAILED');
  assert.ok(bw.RATE_RE.test('100M') && bw.RATE_RE.test('1.5G') && !bw.RATE_RE.test('100; rm') && !bw.RATE_RE.test('-1'));
});

/* ------------------------------------------------------------------ tcpdump */

test('tcpdump lines + summary + filter', () => {
  const udp = cap.parseTcpdumpLine('03:12:41.123456 IP 192.168.1.20.5000 > 192.168.1.12.4000: UDP, length 1400');
  assert.deepEqual(udp, { time: '03:12:41', src: '192.168.1.20:5000', dst: '192.168.1.12:4000', proto: 'UDP', info: '1400 bytes' });
  const tcp = cap.parseTcpdumpLine('03:12:41.223456 IP 192.168.1.12.22 > 192.168.1.20.51234: tcp 52');
  assert.equal(tcp.proto, 'TCP'); assert.equal(tcp.info, '52 bytes');
  const v6 = cap.parseTcpdumpLine('03:12:42.000001 IP6 fe80::1.5353 > ff02::fb.5353: UDP, length 100');
  assert.equal(v6.src, 'fe80::1:5353'); assert.equal(v6.proto, 'UDP');
  assert.equal(cap.parseTcpdumpLine('03:12:43.1 ARP, Request who-has 192.168.1.1 tell 192.168.1.12, length 28').proto, 'ARP');
  assert.equal(cap.parseTcpdumpLine('tcpdump: listening on eth0, link-type EN10MB'), null);
  assert.deepEqual(cap.parseTcpdumpSummary('12 packets captured\n12 packets received by filter\n3 packets dropped by kernel\n'), { captured: 12, receivedByFilter: 12, droppedByKernel: 3 });
  assert.deepEqual(cap.buildFilter({ host: '192.168.1.20', port: 8080, tcp: true }), ['host', '192.168.1.20', 'and', 'port', '8080', 'and', 'tcp']);
  assert.deepEqual(cap.buildFilter({ tcp: true, udp: true }), []);
});

/* ------------------------------------------------------------------ nmap */

test('nmap grepable output', () => {
  const out = `# Nmap 7.94 scan initiated\nHost: 192.168.1.20 (jetson.local)\tStatus: Up\nHost: 192.168.1.20 (jetson.local)\tPorts: 22/open/tcp//ssh//OpenSSH 8.2p1 Ubuntu 4ubuntu0.5 (Ubuntu Linux; protocol 2.0)/, 80/open/tcp//http//nginx 1.18.0/, 554/open/tcp//rtsp///, 8080/closed/tcp//http-proxy///\tIgnored State: closed (96)\tOS: Linux 5.10 (Tegra)\nHost: 192.168.1.30 ()\tStatus: Down\n`;
  const hosts = sec.parseNmapGrep(out);
  assert.equal(hosts.length, 2);
  const j = hosts[0];
  assert.equal(j.status, 'UP'); assert.equal(j.hostname, 'jetson.local'); assert.equal(j.os, 'Linux 5.10 (Tegra)');
  assert.deepEqual(j.ports.map(p => [p.port, p.state, p.service]), [[22, 'open', 'ssh'], [80, 'open', 'http'], [554, 'open', 'rtsp'], [8080, 'closed', 'http-proxy']]);
  assert.match(j.ports[0].version, /OpenSSH 8\.2p1/); assert.equal(j.ports[2].version, null);
  assert.equal(hosts[1].status, 'DOWN');
});
