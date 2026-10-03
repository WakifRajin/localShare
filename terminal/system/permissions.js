'use strict';
const fs = require('fs');
const platform = require('./platform');

const CAP_NET_ADMIN = 12, CAP_NET_RAW = 13;

function isRoot() {
  if (platform.isWindows) return false; // admin elevation is not probed; Windows commands report their own errors
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function effectiveCaps() {
  if (!platform.isLinux) return null;
  try {
    const m = /CapEff:\s*([0-9a-fA-F]+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return m ? BigInt('0x' + m[1]) : null;
  } catch { return null; }
}
const hasCap = bit => { const c = effectiveCaps(); return c !== null && ((c >> BigInt(bit)) & 1n) === 1n; };

/** Can this process open raw sockets (packet capture, ARP scans, SYN scans)? */
function canCapture() { return isRoot() || hasCap(CAP_NET_RAW); }

const looksLikePermissionError = text => /operation not permitted|permission denied|you don't have permission|must be root|requires root|insufficient permissions|access is denied/i.test(text || '');

function captureHint(tool) {
  if (platform.isWindows) return ['Run the terminal from an elevated (Administrator) prompt.'];
  return [
    `Run with elevated privileges (sudo), or grant just this capability:`,
    `  sudo setcap cap_net_raw,cap_net_admin=eip $(which ${tool})`,
  ];
}

module.exports = { isRoot, hasCap, canCapture, looksLikePermissionError, captureHint, CAP_NET_ADMIN, CAP_NET_RAW };
