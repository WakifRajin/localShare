'use strict';
/**
 * The only place that starts child processes. Always `spawn` with an argv array and
 * `shell: false` — arguments are never concatenated into a shell string.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const platform = require('./platform');
const { CmdError } = require('../errors');
const config = require('../config');

const EXTRA_PATHS = platform.isUnix ? ['/usr/local/sbin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/bin', '/bin'] : [];
const whichCache = new Map();

function candidates(cmd) {
  if (!platform.isWindows) return [cmd];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  return [cmd, ...exts.map(e => cmd + e.toLowerCase()), ...exts.map(e => cmd + e)];
}

/** Absolute path of an executable, or null. Looks in PATH plus the sbin directories non-root users often lack. */
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATHS].filter(Boolean);
  let found = null;
  outer: for (const d of dirs) {
    for (const c of candidates(cmd)) {
      const full = path.join(d, c);
      try {
        if (fs.statSync(full).isFile()) { found = full; break outer; }
      } catch { /* not here */ }
    }
  }
  whichCache.set(cmd, found);
  return found;
}
const has = cmd => !!which(cmd);

/** Like which(), but throws a MISSING_DEPENDENCY error with an install hint. */
function need(cmd, why) {
  const p = which(cmd);
  if (p) return p;
  const hint = platform.isLinux ? config.installHints[cmd] : platform.isMac ? `brew install ${cmd === 'dig' ? 'bind' : cmd}` : null;
  throw new CmdError('MISSING_DEPENDENCY', `'${cmd}' is not installed${why ? ` (${why})` : ''}.`, {
    hints: hint ? [`Install it with: ${hint}`] : [`Install '${cmd}' and make sure it is on your PATH.`],
  });
}

function lineSplitter(cb) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { cb(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    },
    flush() { if (buf) cb(buf.replace(/\r$/, '')); buf = ''; },
  };
}

/**
 * Run a program to completion.
 * @param {string} cmd   program name (resolved through which()) or absolute path
 * @param {string[]} args
 * @param {{signal?:AbortSignal, timeoutMs?:number, onLine?:(l:string)=>void, onErrLine?:(l:string)=>void,
 *          input?:string, env?:object, cwd?:string, stopSignal?:string}} opts
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}>}
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = path.isAbsolute(cmd) ? cmd : which(cmd);
    if (!bin) return reject(new CmdError('MISSING_DEPENDENCY', `'${cmd}' is not installed.`));
    let child;
    try {
      child = spawn(bin, args.map(String), {
        shell: false, windowsHide: true, cwd: opts.cwd,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...(opts.env || {}) },
        stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new CmdError('FAILED', `could not start '${cmd}': ${e.message}`));
    }

    let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false, killTimer = null;
    const out = lineSplitter(l => opts.onLine && opts.onLine(l));
    const err = lineSplitter(l => opts.onErrLine && opts.onErrLine(l));

    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      // Ask nicely first (ping/tcpdump/iperf3 print their summary on SIGINT), then insist.
      try { child.kill(opts.stopSignal || (platform.isWindows ? undefined : 'SIGINT')); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2500);
    };
    const onAbort = () => { aborted = true; stop(); };
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs) : null;

    child.stdout.on('data', d => { const s = d.toString('utf8'); stdout += s; if (stdout.length > 8e6) stdout = stdout.slice(-4e6); out.push(s); });
    child.stderr.on('data', d => { const s = d.toString('utf8'); stderr += s; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); err.push(s); });
    if (opts.input != null) { child.stdin.on('error', () => {}); child.stdin.end(opts.input); }

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      out.flush(); err.flush();
      fn();
    };
    child.on('error', e => done(() => reject(new CmdError('FAILED', `could not run '${cmd}': ${e.code === 'EACCES' ? 'permission denied' : e.message}`, e.code === 'EACCES' ? { hints: ['Check file permissions.'] } : {}))));
    child.on('close', code => done(() => resolve({ code, stdout, stderr, timedOut, aborted })));
  });
}

/** run() that throws on non-zero exit, with the program's own message. */
async function runChecked(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
  if (r.timedOut) throw new CmdError('TIMEOUT', `'${cmd}' timed out`);
  if (r.code !== 0) throw new CmdError('FAILED', (r.stderr || r.stdout || `'${cmd}' exited with code ${r.code}`).trim().split('\n')[0]);
  return r;
}

/** Windows helper: run a PowerShell snippet, passing user values through environment variables (never the script text). */
function powershell(script, { env, signal, timeoutMs = 15000 } = {}) {
  const exe = which('powershell') || which('pwsh');
  if (!exe) throw new CmdError('MISSING_DEPENDENCY', 'PowerShell is not available.');
  return run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, signal, timeoutMs });
}

/** PowerShell snippet that prints JSON -> always an array (empty when there is no output). */
async function psJson(script, opts) {
  const r = await powershell(script, opts);
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
  const txt = r.stdout.trim();
  if (!txt) return [];
  try { const j = JSON.parse(txt); return Array.isArray(j) ? j : [j]; }
  catch { throw new CmdError('FAILED', 'could not read the system response (unexpected PowerShell output)'); }
}

module.exports = { which, has, need, run, runChecked, powershell, psJson, lineSplitter };
