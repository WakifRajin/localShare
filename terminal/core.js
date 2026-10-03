'use strict';
/**
 * The execution pipeline: parse -> resolve -> validate -> (confirm) -> run -> log.
 * It knows nothing about where output goes — callers (CLI, web server) pass an `io` object:
 *   io.emit({type:'out'|'frame', data})   write text (frame = replace the previous live frame)
 *   io.signal                             AbortSignal, aborted on Ctrl+C
 *   io.confirm(promptLabel) -> Promise<boolean>
 *   io.color                              allow ANSI colour in human output
 */
const { CmdError } = require('./errors');
const { tokenize, parseArgs } = require('./parser');
const registry = require('./registry');
const runner = require('./system/command_runner');
const platform = require('./system/platform');
const config = require('./config');
const { makeStyle, banner, padEnd } = require('./output/terminal');
const { renderTable } = require('./output/tables');
const { kv } = require('./output/terminal');
const jsonOut = require('./output/json');
const { Logger } = require('./logging/logger');

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Dependency detection for the startup "SYSTEM CAPABILITIES" panel. */
function capabilities() {
  return config.dependencies.map(dep => {
    const supported = dep.needs === 'any' || (dep.needs === 'linux' && platform.isLinux) || (dep.needs === 'unix' && platform.isUnix);
    const alt = dep.name === 'traceroute' ? ['tracepath', 'tracert'] : dep.name === 'ip' || dep.name === 'ss' ? [] : [];
    const p = runner.which(dep.name) || alt.map(runner.which).find(Boolean) || null;
    return { name: dep.name, available: !!p, path: p, supported, optional: !!dep.optional, purpose: dep.purpose, hint: config.installHints[dep.name] || null };
  });
}

function renderCapabilities(style) {
  const caps = capabilities();
  const lines = [style.head('SYSTEM CAPABILITIES'), ''];
  for (const c of caps) {
    if (!c.supported) lines.push(`${style.gray('–')} ${style.gray(padEnd(c.name, 10))} ${style.gray(`not applicable on ${platform.label()}`)}`);
    else lines.push(`${c.available ? style.ok('✓') : style.err('✗')} ${c.name}`);
  }
  const missing = caps.filter(c => c.supported && !c.available);
  if (missing.length) {
    lines.push('', style.warn(`Optional dependency missing: ${missing.map(m => m.name).join(', ')}`));
    for (const m of missing) if (m.hint && platform.isLinux) lines.push(style.dim(`  ${m.name.padEnd(10)} ${m.hint}  — ${m.purpose}`));
    else if (!platform.isLinux) lines.push(style.dim(`  ${m.name.padEnd(10)} ${m.purpose}`));
  }
  return lines.join('\n');
}

function usageText(def, style) {
  const lines = [style.head(def.path.toUpperCase()), '', `  ${def.summary}`, '', style.label('USAGE'), `  ${def.usage || def.path}`];
  const opts = Object.entries({ ...(def.options || {}) });
  if (opts.length) {
    lines.push('', style.label('OPTIONS'));
    for (const [n, o] of opts) lines.push(`  ${padEnd(`--${n}${o.alias ? `, -${o.alias}` : ''}${o.type !== 'bool' ? ` <${o.type === 'number' ? 'n' : 'value'}>` : ''}`, 24)}${o.desc || ''}`);
  }
  lines.push('', style.label('COMMON OPTIONS'), `  ${padEnd('--help, -h', 24)}this help`, `  ${padEnd('--json', 24)}machine-readable output`, `  ${padEnd('--verbose, -v', 24)}more detail`, `  ${padEnd('--quiet, -q', 24)}minimal output`, `  ${padEnd('--yes, -y', 24)}skip confirmation prompts`);
  if (def.examples && def.examples.length) lines.push('', style.label('EXAMPLES'), ...def.examples.map(e => `  ${e}`));
  return lines.join('\n') + '\n';
}

function createTerminal({ logger = new Logger(), extraInfo = () => ({}) } = {}) {
  const startedAt = Date.now();

  async function execute(line, io) {
    const t0 = Date.now();
    let exit = 0, result = 'ok';
    const ctxMeta = { target: null };
    const emit = ev => { try { io.emit(ev); } catch { /* a closed sink must not crash us */ } };
    const text = s => emit({ type: 'out', data: s });
    let json = false, style = makeStyle(!!io.color);

    try {
      const tokens = tokenize(line);
      if (!tokens.length) return 0;
      const { def, rest, prefix } = registry.resolve(tokens);

      if (!def) {
        if (prefix) {
          const subs = registry.subcommands(prefix);
          text(`${style.head(prefix.toUpperCase() + ' COMMANDS')}\n\n` + subs.map(d => `  ${padEnd(d.path, 26)}${d.summary}`).join('\n') + '\n');
          return 0;
        }
        const names = registry.allNames();
        const near = names.filter(n => levenshtein(n, tokens[0]) <= 2 || n.startsWith(tokens[0])).slice(0, 3);
        throw new CmdError('USAGE', `unknown command '${tokens[0]}'.`, { hints: [near.length ? `Did you mean: ${near.join(', ')}?` : "Type 'help' to list commands."] });
      }

      const { args, opts } = parseArgs(rest, def.options);
      json = !!opts.json;
      style = makeStyle(!!io.color && !json);
      if (opts.help) { text(usageText(def, style)); return 0; }

      const min = def.args ? def.args.min || 0 : 0, max = def.args && def.args.max !== undefined ? def.args.max : (def.args ? min : 0);
      if (args.length < min) throw new CmdError('USAGE', `missing argument${def.args.names ? ` <${def.args.names[args.length] || def.args.names[0]}>` : ''}.`, { hints: [`Usage: ${def.usage || def.path}`] });
      if (args.length > max) throw new CmdError('USAGE', `unexpected argument '${args[max]}'.`, { hints: [`Usage: ${def.usage || def.path}`] });

      const quiet = !!opts.quiet;
      const out = {
        text: s => { if (!json) text(s); },
        line: (s = '') => { if (!json) text(s + '\n'); },
        info: (s = '') => { if (!json && !quiet) text(s + '\n'); },
        frame: s => { if (!json) emit({ type: 'frame', data: s }); },
        table: (cols, rows, o) => { if (!json) text(renderTable(style, cols, rows, o) + '\n'); },
        kv: (pairs, o) => { if (!json) text(kv(style, pairs, o) + '\n'); },
        result: (data, render) => { if (json) text(jsonOut.stringify(data) + '\n'); else render(data); },
        jsonLine: obj => text(jsonOut.stringify(obj, true) + '\n'),       // NDJSON for streaming commands
      };

      const ctx = {
        args, opts, style, out, json, quiet, verbose: !!opts.verbose, signal: io.signal, meta: ctxMeta,
        session: { logger, startedAt, capabilities, renderCapabilities: () => renderCapabilities(style), extra: extraInfo },
        runner, platform,
        async confirmAction(c) {
          if (opts.yes) return true;
          if (json || !io.confirm) throw new CmdError('USAGE', 'this command needs confirmation; re-run with --yes to confirm in advance.');
          const head = c.title === 'NOTICE' ? style.cyan('NOTICE') : style.warn('WARNING');
          text(`\n${head}\n\n${c.lines.join('\n')}\n\n`);
          const ok = await io.confirm(c.prompt || 'Continue?');
          if (!ok) text('Aborted.\n');
          return ok;
        },
        exitCode: 0,                                   // commands set this to report a non-zero status without an error
        throwIfAborted() { if (io.signal && io.signal.aborted) throw new CmdError('CANCELLED', 'cancelled', { exit: 130 }); },
      };

      if (def.confirm) {
        const c = await def.confirm(ctx);
        if (c && !(await ctx.confirmAction(c))) { result = 'aborted'; return (exit = 1); }
      }
      await def.run(ctx);
      exit = ctx.exitCode || 0;
    } catch (e) {
      if (e instanceof CmdError) {
        exit = e.exit; result = e.code === 'CANCELLED' ? 'cancelled' : `error:${e.code}`;
        if (e.code === 'CANCELLED') text(json ? '' : '\n' + makeStyle(!!io.color).dim('Cancelled.') + '\n');
        else if (json) text(jsonOut.stringify(jsonOut.errorObject(e)) + '\n');
        else {
          const st = makeStyle(!!io.color);
          text(`${st.err('ERROR:')} ${e.message}\n` + (e.hints.length ? '\n' + e.hints.join('\n') + '\n' : ''));
        }
      } else {
        exit = 1; result = 'error:INTERNAL';
        const msg = e && e.message ? e.message : String(e);
        if (json) text(jsonOut.stringify({ error: { code: 'INTERNAL', message: msg } }) + '\n');
        else text(`${makeStyle(!!io.color).err('ERROR:')} unexpected failure: ${msg}\n`);
      }
    } finally {
      logger.record({ command: line, target: ctxMeta.target, result, durationMs: Date.now() - t0, exit });
    }
    return exit;
  }

  return {
    execute,
    capabilities,
    renderCapabilities,
    banner: style => banner(style, config.name, 'NETWORK DIAGNOSTICS'),
    logger,
    info: () => ({ name: config.name, version: config.version, platform: platform.label(), hostname: platform.hostname(), user: platform.username(), startedAt, ...extraInfo() }),
  };
}

module.exports = { createTerminal, capabilities, renderCapabilities, usageText };
