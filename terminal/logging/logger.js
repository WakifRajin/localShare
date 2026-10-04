'use strict';
/**
 * Structured diagnostic log (JSON Lines): one object per command with timestamp, command,
 * target, result, duration and exit status. Secrets are redacted before anything is written.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const SECRET_WORDS = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|bearer|cookie|credential|private[-_]?key|psk)/i;

/** Remove credentials from a command line before it is logged or persisted. */
function redact(line) {
  return String(line)
    .replace(/(\/\/)([^\s/@:]+):([^\s/@]+)@/g, '$1$2:***@')                           // user:pass@host in URLs
    .replace(/(--?[A-Za-z-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|bearer|cookie|psk)[A-Za-z-]*)(=|\s+)(\S+)/gi, '$1$2***')
    .replace(/\b((?:pass(?:word|wd)?|secret|token|api[-_]?key|psk)=)(\S+)/gi, '$1***');
}
const containsSecret = line => redact(line) !== String(line) || SECRET_WORDS.test(String(line));

class Logger {
  constructor() { this.active = false; this.file = null; this.count = 0; this.startedAt = null; }

  start(fileName) {
    if (this.active) return { already: true, file: this.file };
    fs.mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = fileName && /^[\w.-]{1,80}$/.test(fileName) ? fileName : `terminal-${stamp}.jsonl`;
    this.file = path.join(config.logDir, safe.endsWith('.jsonl') ? safe : safe + '.jsonl');
    this.active = true; this.count = 0; this.startedAt = new Date();
    return { already: false, file: this.file };
  }

  stop() {
    const info = { file: this.file, entries: this.count, startedAt: this.startedAt };
    this.active = false; this.file = null;
    return info;
  }

  status() { return { active: this.active, file: this.file, entries: this.count, startedAt: this.startedAt }; }

  record({ command, target, result, durationMs, exit }) {
    if (!this.active) return;
    const entry = {
      timestamp: new Date().toISOString(),
      command: redact(command),
      target: target ? redact(String(target)) : null,
      result: result || null,
      durationMs: Math.round(durationMs),
      exitStatus: exit,
    };
    try { fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 }); this.count++; } catch { /* a logging failure must never break a command */ }
  }
}

module.exports = { Logger, redact, containsSecret };
