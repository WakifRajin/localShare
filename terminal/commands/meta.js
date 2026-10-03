'use strict';
const os = require('os');
const config = require('../config');
const platform = require('../system/platform');
const perms = require('../system/permissions');
const { fmtInt } = require('../output/terminal');

const duration = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`; };

const defs = [
  {
    path: 'version',
    summary: 'Show version information',
    usage: 'version',
    run(ctx) {
      const data = { name: config.name, version: config.version, node: process.version, platform: platform.label(), release: platform.release() };
      ctx.out.result(data, d => ctx.out.line(`${ctx.style.bold(d.name)} ${d.version}\n${ctx.style.label('runtime')}   node ${d.node}\n${ctx.style.label('platform')}  ${d.release}`));
    },
  },
  {
    path: 'status',
    summary: 'Show terminal status, privileges and available tools',
    usage: 'status',
    run(ctx) {
      const caps = ctx.session.capabilities();
      const log = ctx.session.logger.status();
      const extra = ctx.session.extra();
      const data = {
        host: platform.hostname(), user: platform.username(), platform: platform.label(), release: platform.release(),
        privileged: perms.isRoot(), rawSockets: platform.isWindows ? null : perms.canCapture(),
        cpus: os.cpus().length, uptimeSec: Math.round(os.uptime()), sessionSec: Math.round((Date.now() - ctx.session.startedAt) / 1000),
        logging: { active: log.active, file: log.file, entries: log.entries },
        capabilities: caps.map(c => ({ name: c.name, available: c.available, applicable: c.supported, path: c.path })),
        ...extra,
      };
      ctx.out.result(data, d => {
        const s = ctx.style;
        ctx.out.kv([
          ['HOST', d.host], ['USER', d.user], ['PLATFORM', d.release],
          ['PRIVILEGES', d.privileged ? s.warn('root') : 'unprivileged'],
          ['RAW SOCKETS', d.rawSockets === null ? 'N/A' : d.rawSockets ? s.ok('available') : s.dim('PERMISSION REQUIRED (capture, arp-scan, nmap -sS/-O)')],
          ['SYSTEM UPTIME', duration(d.uptimeSec * 1000)], ['SESSION', duration(d.sessionSec * 1000)],
          ['LOGGING', d.logging.active ? `${s.ok('on')}  ${d.logging.file}  (${fmtInt(d.logging.entries)} entries)` : s.dim('off')],
          ...(extra.p2p ? [['P2P SESSION', extra.p2p]] : []),
        ]);
        ctx.out.line('\n' + ctx.session.renderCapabilities());
      });
    },
  },
  {
    path: 'log start',
    summary: 'Start writing structured (JSON Lines) diagnostic logs',
    usage: 'log start [--file <name>]',
    options: { file: { type: 'string', desc: 'log file name (stored under the data directory)' } },
    run(ctx) {
      const r = ctx.session.logger.start(ctx.opts.file);
      ctx.out.result({ logging: true, file: r.file, alreadyActive: r.already }, d =>
        ctx.out.line(d.alreadyActive ? `Logging is already on: ${d.file}` : `Logging started.\n${ctx.style.label('file')} ${d.file}\n${ctx.style.dim('Records timestamp, command, target, result, duration and exit status. Credentials are redacted.')}`));
    },
  },
  {
    path: 'log stop',
    summary: 'Stop logging',
    usage: 'log stop',
    run(ctx) {
      const st = ctx.session.logger.status();
      if (!st.active) return ctx.out.result({ logging: false }, () => ctx.out.line('Logging is not active.'));
      const r = ctx.session.logger.stop();
      ctx.out.result({ logging: false, file: r.file, entries: r.entries }, d => ctx.out.line(`Logging stopped. ${fmtInt(d.entries)} entries written to ${d.file}`));
    },
  },
  {
    path: 'log status',
    summary: 'Show logging state',
    usage: 'log status',
    run(ctx) {
      const st = ctx.session.logger.status();
      ctx.out.result({ logging: st.active, file: st.file, entries: st.entries, since: st.startedAt }, d =>
        ctx.out.kv([['LOGGING', d.logging ? ctx.style.ok('on') : ctx.style.dim('off')], ['FILE', d.file || 'N/A'], ['ENTRIES', fmtInt(d.entries)], ['LOG DIRECTORY', config.logDir]]));
    },
  },
];

module.exports = defs;
