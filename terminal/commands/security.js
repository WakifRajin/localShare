'use strict';
/**
 * security scan | ports | services   — authorized network auditing with nmap.
 * Deliberately limited to discovery and service identification: no exploitation, brute-forcing,
 * evasion/stealth options, or denial-of-service features exist in this module.
 */
const runner = require('../system/command_runner');
const perms = require('../system/permissions');
const { CmdError } = require('../errors');
const V = require('../system/validate');
const { fmtInt } = require('../output/terminal');
const discovery = require('./discovery');

/* ================================================================ parsers (pure) */

/** nmap -oG output -> hosts */
function parseNmapGrep(text) {
  const hosts = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith('Host:')) continue;
    const fields = line.split('\t');
    const m = /^Host:\s+(\S+)\s+\(([^)]*)\)/.exec(fields[0]);
    if (!m) continue;
    const h = hosts.get(m[1]) || { ip: m[1], hostname: m[2] || null, status: null, ports: [], os: null };
    for (const f of fields.slice(1)) {
      const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(f.trim());
      if (!kv) continue;
      if (kv[1] === 'Status') h.status = kv[2].trim().toUpperCase();
      else if (kv[1] === 'OS') h.os = kv[2].trim() || null;
      else if (kv[1] === 'Ports') {
        for (const entry of kv[2].split(/,\s+(?=\d+\/)/)) {
          const p = entry.trim().replace(/\/$/, '').split('/');   // nmap terminates every entry with "/"
          if (p.length < 5) continue;
          h.ports.push({ port: Number(p[0]), state: p[1], protocol: p[2], service: p[4] || null, version: (p.slice(6).join('/') || '').trim() || null });
        }
      }
    }
    hosts.set(m[1], h);
  }
  return [...hosts.values()];
}

/* ================================================================ helpers */

const SAFE_TIMING = ['-T3', '--max-retries', '2', '--host-timeout', '10m'];

async function authorizeTarget(ctx, t) {
  const priv = await discovery.targetIsPrivate(t);
  if (!priv && !ctx.opts.authorized)
    throw new CmdError('USAGE', `'${t.value}' is not on a private network.`, { hints: ['Security scans are limited to private/LAN addresses by default.', 'If you own it or have written authorization, add --authorized to confirm that.'] });
  return priv;
}

function checkCidrSize(t) {
  if (t.kind === 'cidr') {
    if (t.family !== 4) throw new CmdError('INVALID', 'only IPv4 ranges are supported');
    if (t.cidr.bits < 22) throw new CmdError('INVALID', `${t.value} is too large (limit: /22, 1024 addresses).`, { hints: ['Scan smaller subnets one at a time.'] });
  }
}

async function runNmap(ctx, label, extraArgs, { needsRaw = false } = {}) {
  runner.need('nmap', 'required for security auditing');
  const t = V.parseTarget(ctx.args[0]);
  checkCidrSize(t);
  ctx.meta.target = ctx.args[0];
  await authorizeTarget(ctx, t);
  if (needsRaw && !perms.canCapture()) throw new CmdError('PERMISSION', 'this option (-O OS detection) needs raw-socket privileges.', { hints: perms.captureHint('nmap') });

  const args = [...extraArgs, ...SAFE_TIMING, '-oG', '-', t.value];
  ctx.out.info(`${ctx.style.head(label)}  ${ctx.style.dim(t.value)}\n${ctx.style.dim('nmap ' + args.slice(0, -1).join(' '))}\n`);
  const started = Date.now();
  const tick = setInterval(() => ctx.out.frame(`${ctx.style.dim('scanning…')} ${Math.round((Date.now() - started) / 1000)} s`), 500);
  let r;
  try { r = await runner.run('nmap', args, { signal: ctx.signal, timeoutMs: 25 * 60 * 1000 }); }
  finally { clearInterval(tick); }
  if (r.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 });
  if (r.timedOut) throw new CmdError('TIMEOUT', 'the scan exceeded its time limit.');
  if (/Failed to resolve|Could not resolve/i.test(r.stderr + r.stdout)) throw new CmdError('DNS', `cannot resolve '${t.value}' (name not found).`);
  if (r.code !== 0 && !/^Host:/m.test(r.stdout)) {
    if (perms.looksLikePermissionError(r.stderr + r.stdout)) throw new CmdError('PERMISSION', 'nmap needs elevated privileges for this scan type.', { hints: perms.captureHint('nmap') });
    throw new CmdError('FAILED', (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() || 'nmap failed');
  }
  return { target: t.value, hosts: parseNmapGrep(r.stdout), seconds: Math.round((Date.now() - started) / 1000), command: ['nmap', ...args.slice(0, -1), t.value] };
}

function render(ctx, data, { versions }) {
  const s = ctx.style;
  ctx.out.line();
  const up = data.hosts.filter(h => h.status === 'UP' || h.ports.length);
  for (const h of up) {
    ctx.out.line(`${s.head(h.ip)}${h.hostname ? s.dim(`  ${h.hostname}`) : ''}${h.os ? s.dim(`  · OS guess: ${h.os}`) : ''}`);
    const open = h.ports.filter(p => p.state === 'open' || ctx.verbose);
    ctx.out.table([
      { key: 'port', title: 'PORT', align: 'right' }, { key: 'protocol', title: 'PROTO' },
      { key: 'state', title: 'STATE', color: x => x === 'open' ? s.ok(x) : x === 'filtered' ? s.warn(x) : s.dim(x) },
      { key: 'service', title: 'SERVICE', format: v => v || 'unknown' }, ...(versions ? [{ key: 'version', title: 'VERSION', format: v => v || '-' }] : []),
    ], open, { empty: '(no open ports found)', indent: 2 });
    ctx.out.line();
  }
  const down = data.hosts.length - up.length;
  ctx.out.line(s.dim(`${up.length} host${up.length === 1 ? '' : 's'} up${down > 0 ? `, ${down} down/unreported` : ''} · ${fmtInt(up.reduce((n, h) => n + h.ports.filter(p => p.state === 'open').length, 0))} open ports · ${data.seconds} s`));
  ctx.out.info(s.dim('Results describe what the target exposes to this host at this moment. Treat open ports as a starting point for review, not a verdict.'));
}

/* ================================================================ definitions */

const common = {
  authorized: { type: 'bool', desc: 'confirm you are authorized to test a non-private target' },
};

const confirmFor = (what, extra = []) => ctx => ({
  title: 'WARNING',
  lines: [`${what}`, 'It can trigger intrusion-detection alerts and load fragile devices.', 'Only audit systems you own or are explicitly authorized to test.', ...extra, '', 'Target:', ctx.args[0]],
  prompt: 'Continue?',
});

const defs = [
  {
    path: 'security scan', summary: 'Authorized host discovery plus a scan of the 100 most common TCP ports (nmap)', usage: 'security scan <target> [--authorized]',
    args: { min: 1, max: 1, names: ['target'] }, options: common, examples: ['security scan 192.168.1.20', 'security scan 192.168.1.0/24'],
    confirm: confirmFor('This will probe the target with TCP connection attempts to its 100 most common ports.'),
    async run(ctx) { const d = await runNmap(ctx, 'SECURITY SCAN', ['-sT', '--top-ports', '100', '--open']); ctx.out.result(d, x => render(ctx, x, { versions: false })); },
  },
  {
    path: 'security ports', summary: 'Authorized port scan of a chosen range (nmap)', usage: 'security ports <target> [--range 1-1024 | --all] [--authorized]',
    args: { min: 1, max: 1, names: ['target'] },
    options: { ...common, range: { type: 'string', desc: 'ports, e.g. 1-1024 or 22,80,443 (default 1-1024)' }, all: { type: 'bool', desc: 'all 65535 TCP ports (slow)' } },
    examples: ['security ports 192.168.1.20', 'security ports 192.168.1.20 --range 1-10000'],
    confirm: ctx => confirmFor(ctx.opts.all ? 'This will probe all 65,535 TCP ports of the target and may take a long time.' : 'This will probe the selected TCP ports of the target.')(ctx),
    async run(ctx) {
      const spec = ctx.opts.all ? '1-65535' : (ctx.opts.range ? V.parsePortList(ctx.opts.range) && String(ctx.opts.range) : '1-1024');
      const d = await runNmap(ctx, 'SECURITY PORTS', ['-sT', '-p', spec, '--open']);
      ctx.out.result(d, x => render(ctx, x, { versions: false }));
    },
  },
  {
    path: 'security services', summary: 'Identify the services/versions behind open ports (nmap -sV); optional default scripts and OS detection', usage: 'security services <target> [--scripts] [--os] [--range ...] [--authorized]',
    args: { min: 1, max: 1, names: ['target'] },
    options: { ...common, range: { type: 'string', desc: 'ports (default: top 100)' }, scripts: { type: 'bool', desc: "run nmap's default scripts (-sC) — more intrusive" }, os: { type: 'bool', desc: 'OS detection (-O) — needs root' } },
    examples: ['security services 192.168.1.20', 'security services 192.168.1.20 --range 1-1024 --os'],
    confirm: ctx => confirmFor('This will connect to open ports and send probes to identify the services and their versions.',
      [...(ctx.opts.scripts ? ["--scripts runs nmap's default NSE scripts, which are more intrusive."] : []), ...(ctx.opts.os ? ['--os sends crafted packets to fingerprint the operating system.'] : [])])(ctx),
    async run(ctx) {
      const extra = ['-sT', '-sV', ...(ctx.opts.range ? ['-p', (V.parsePortList(ctx.opts.range), String(ctx.opts.range))] : ['--top-ports', '100']), '--open', ...(ctx.opts.scripts ? ['-sC'] : []), ...(ctx.opts.os ? ['-O'] : [])];
      const d = await runNmap(ctx, 'SECURITY SERVICES', extra, { needsRaw: !!ctx.opts.os });
      ctx.out.result(d, x => render(ctx, x, { versions: true }));
    },
  },
];

module.exports = Object.assign(defs, { parsers: { parseNmapGrep } });
