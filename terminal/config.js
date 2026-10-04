'use strict';
const os = require('os');
const path = require('path');

module.exports = {
  name: 'Terminal',
  version: '1.0.0',

  // Where structured logs and packet captures are written.
  get dataDir() { return process.env.NETTERM_HOME || path.join(os.homedir(), '.localshare'); },
  get logDir() { return path.join(this.dataDir, 'logs'); },
  get captureDir() { return path.join(this.dataDir, 'captures'); },

  defaults: {
    pingCount: 4,
    pingMaxCount: 1000,
    tcpTimeoutMs: 3000,
    httpTimeoutMs: 10000,
    dnsTimeoutMs: 5000,
    scanConcurrency: 64,
    scanTimeoutMs: 800,
    sweepConcurrency: 32,
    sweepMaxHosts: 1024,
    monitorIntervalSec: 1,
    historyLimit: 200,
  },

  // Tools the terminal knows how to drive. `optional` ones never block startup.
  dependencies: [
    { name: 'ip',        needs: 'linux',   purpose: 'interfaces, routes, neighbors' },
    { name: 'ss',        needs: 'linux',   purpose: 'connections and listening ports' },
    { name: 'ping',      needs: 'any',     purpose: 'reachability, MTU discovery' },
    { name: 'traceroute', needs: 'any',    purpose: 'path tracing (tracepath / tracert also work)', optional: true },
    { name: 'dig',       needs: 'any',     purpose: 'extra DNS detail (built-in resolver is used otherwise)', optional: true },
    { name: 'nmap',      needs: 'any',     purpose: 'security auditing', optional: true },
    { name: 'iperf3',    needs: 'any',     purpose: 'bandwidth testing', optional: true },
    { name: 'tcpdump',   needs: 'unix',    purpose: 'packet capture', optional: true },
    { name: 'ethtool',   needs: 'linux',   purpose: 'Ethernet link diagnostics', optional: true },
    { name: 'curl',      needs: 'any',     purpose: 'optional; HTTP diagnostics are built in', optional: true },
    { name: 'arp-scan',  needs: 'unix',    purpose: 'enhanced LAN discovery', optional: true },
  ],

  installHints: {
    ip: 'sudo apt install iproute2', ss: 'sudo apt install iproute2', ping: 'sudo apt install iputils-ping',
    traceroute: 'sudo apt install traceroute', dig: 'sudo apt install dnsutils', nmap: 'sudo apt install nmap',
    iperf3: 'sudo apt install iperf3', tcpdump: 'sudo apt install tcpdump', ethtool: 'sudo apt install ethtool',
    curl: 'sudo apt install curl', 'arp-scan': 'sudo apt install arp-scan',
  },
};
