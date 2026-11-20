#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const { loadWills, buildEstate, ago } = require('../src/estate');
const { onDeath, runJob, prepare, writePlain, refine, settleIntestate } = require('../src/scribe');
const { resolveEngine, publikKey, onPath } = require('../src/engines');
const { header, cap, firstSentence } = require('../src/will');
const { readTranscript, shorten } = require('../src/transcript');
const { redact } = require('../src/redact');

const VERSION = require('../package.json').version;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const gold = c('33');
const red = c('31');
const green = c('32');

function argFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function hookLog(msg) {
  try {
    const f = path.join(store.HOME_DIR(), 'hook.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.renameSync(f, f + '.1');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* nowhere to complain */
  }
}

function kb(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function when(died) {
  const a = ago(died);
  return a ? `${died} ${dim(`(${a})`)}` : died;
}

// ---------------------------------------------------------------- hooks

async function hook(event) {
  if (process.env.AGENT_WILLS_CHILD || process.env.WILLS_OFF) return;
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  try {
    if (event === 'session-start') return sessionStart(input);
    if (event === 'session-end') {
      const r = onDeath({ transcript: input.transcript_path, cwd: input.cwd, reason: input.reason, sessionId: input.session_id, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT });
      hookLog(`session-end ${input.session_id || '?'} → ${r ? `${r.file} (${r.kept ? 'kept self-written' : r.engine})` : 'no will (died young)'}`);
      return;
    }
    if (event === 'subagent-stop') {
      if (!input.agent_transcript_path) return;
      const r = onDeath({
        subagent: true,
        transcript: input.agent_transcript_path,
        cwd: input.cwd,
        agentId: input.agent_id,
        agentType: input.agent_type,
        lastMessage: input.last_assistant_message,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      });
      hookLog(`subagent-stop ${input.agent_id || '?'} → ${r ? r.file : 'no will'}`);
    }
  } catch (e) {
    hookLog(`${event} failed: ${e.stack || e.message}`);
  }
}

const scripted = () => /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '');

function sessionStart(input) {
  const cfg = store.loadConfig();
  if (!cfg.estate) return;
  if (scripted() && !cfg.scripted) return;
  if (input.source === 'resume') return;
  const cwd = input.cwd || process.cwd();
  if (!input.source || input.source === 'startup') {
    try {
      for (const r of settleIntestate({ transcript: input.transcript_path, sessionId: input.session_id, cwd, cfg })) {
        hookLog(`session-start settled ${r.id}, which never said goodbye → ${r.file} (${r.engine})`);
      }
    } catch (e) {
      hookLog(`settling failed: ${e.stack || e.message}`);
    }
  }
  const estate = buildEstate(store.willsDir(cwd, cfg), { cwd });
  const err = store.lastError();
  const out = {};
  if (estate) {
    out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: estate.text };
    const ep = estate.latest && estate.latest.epitaph ? ` Latest: “${estate.latest.epitaph.slice(0, 90)}${estate.latest.epitaph.length > 90 ? '…' : ''}”` : '';
    out.systemMessage = estate.count
      ? `📜 Inherited ${estate.count} will${estate.count === 1 ? '' : 's'}.${ep}`
      : `📜 Inherited ${estate.subagents} subagent will${estate.subagents === 1 ? '' : 's'}.`;
  }
  if (err && err.kind === 'balance' && Date.now() - Date.parse(err.at) < 7 * 864e5) {
    out.systemMessage = `${out.systemMessage ? out.systemMessage + ' ' : ''}Agent Wills: publik balance is empty, so wills are plain for now. Add credit: ${err.topUpUrl || 'https://publikhq.com'}`;
  }
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
}

// ---------------------------------------------------------------- reading

function resolveWill(wills, ref) {
  if (!ref || ref === true || ref === 'latest') return wills[0];
  if (/^\d+$/.test(ref)) return wills[Number(ref) - 1];
  return wills.find((w) => path.basename(w.file).includes(ref) || (w.who || '').startsWith(ref));
}

function cmdList(args) {
  const all = !!argFlag(args, '--all');
  const dir = store.willsDir(process.cwd());
  const wills = loadWills(dir);
  const main = wills.filter((w) => !w.subagent);
  const subs = wills.filter((w) => w.subagent);
  const shown = all ? wills : main;
  if (!wills.length) {
    console.log(`No wills here yet ${dim(`(${prettyDir(dir)})`)}.`);
    console.log(dim('They appear when a Claude Code session or subagent in this folder ends. Check setup with: wills doctor'));
    return;
  }
  const bytes = wills.reduce((s, w) => s + w.bytes, 0);
  console.log(
    `${gold('📜')} ${bold(`${main.length} will${main.length === 1 ? '' : 's'}`)}${subs.length ? ` + ${subs.length} from subagents` : ''} in ${prettyDir(dir)}  ${dim(`${kb(bytes)} total · ~${Math.round(bytes / 4)} tokens`)}\n`
  );
  shown.forEach((w, i) => {
    const n = String(i + 1).padStart(3);
    console.log(`${dim(n)}  ${bold(w.title || path.basename(w.file))}  ${dim(`${w.subagent ? 'subagent · ' : ''}${w.engine || '?'} · ${kb(w.bytes)}`)}`);
    console.log(`     ${dim(w.died || '')}${ago(w.died) ? dim(` · ${ago(w.died)}`) : ''}`);
    if (w.epitaph) console.log(`     ${gold('“')}${w.epitaph}${gold('”')}`);
  });
  if (!all && subs.length) console.log(dim(`\n  + ${subs.length} subagent wills: wills list --all`));
  console.log(dim(`\n  read one: wills read 1 · what the next agent inherits: wills estate`));
  const err = store.lastError();
  if (err) console.log(red(`\n  last will-writing error: ${err.message}${err.topUpUrl ? ` → ${err.topUpUrl}` : ''}`));
}

function cmdRead(args) {
  const all = loadWills(store.willsDir(process.cwd()));
  const w = resolveWill(all.filter((x) => !x.subagent).concat(all.filter((x) => x.subagent)), args[0]);
  if (!w) {
    console.error(all.length ? `No will matches "${args[0]}". Try: wills list --all` : 'No wills here yet.');
    process.exitCode = 1;
    return;
  }
  if (!tty) return process.stdout.write(w.text);
  let prev = '';
  for (const line of w.text.split('\n')) {
    if (line.startsWith('# ')) console.log(bold(line));
    else if (line.startsWith('## ')) console.log((prev.trim() ? '\n' : '') + gold(line.slice(3)));
    else if (line.startsWith('>')) console.log(gold('│ ') + line.replace(/^>\s*/, ''));
    else if (/^(died|written)/.test(line) || line.includes(' · written by ')) console.log(dim(line));
    else console.log(line);
    prev = line;
  }
  console.log(dim(`\n${prettyPath(w.file)} · ${kb(w.bytes)}`));
}

function cmdEstate() {
  const cwd = process.cwd();
  const estate = buildEstate(store.willsDir(cwd), { cwd });
  if (!estate) return console.log('Nothing to inherit here yet.');
  console.log(dim('What the next agent in this folder is told at start-up:\n'));
  console.log(estate.text);
  console.log(dim(`\n${estate.text.length} chars · ~${Math.round(estate.text.length / 4)} tokens`));
}

function cmdRecall(args) {
  const q = args.join(' ').trim().toLowerCase();
  if (!q) return console.error('usage: wills recall <words>');
  const words = q.split(/\s+/);
  const hits = [];
  for (const w of loadWills(store.willsDir(process.cwd()))) {
    const lines = w.text.split('\n');
    const match = lines.filter((l) => words.every((x) => l.toLowerCase().includes(x)));
    const anywhere = words.every((x) => w.text.toLowerCase().includes(x));
    if (match.length || anywhere) hits.push({ w, lines: match.length ? match : [w.epitaph] });
  }
  if (!hits.length) return console.log(`No will mentions "${q}".`);
  for (const { w, lines } of hits) {
    console.log(`${bold(w.title)} ${dim(`· ${w.died} · ${path.basename(w.file)}`)}`);
    for (const l of lines.slice(0, 4)) console.log(`  ${l.replace(/^#+\s*/, '')}`);
  }
}

// ---------------------------------------------------------------- writing

async function cmdWrite(args) {
  const engineFlag = argFlag(args, '--engine');
  const transcript = argFlag(args, '--transcript') || store.latestTranscript(process.cwd());
  if (!transcript || transcript === true) {
    console.error('No Claude Code transcript found for this folder. Pass one with --transcript <file.jsonl>.');
    process.exitCode = 1;
    return;
  }
  const cfg = store.loadConfig();
  const prep = prepare({ transcript, cwd: process.cwd(), reason: 'manual', cfg, force: true });
  if (!prep) {
    console.error('That transcript is empty.');
    process.exitCode = 1;
    return;
  }
  writePlain(prep);
  const engine = engineFlag && engineFlag !== true ? engineFlag : resolveEngine(cfg);
  if (engine !== 'plain') process.stderr.write(dim(`writing with ${engine}…\n`));
  const r = await refine(prep, engine);
  if (r.error) console.error(red(`${engine} failed (${r.error.message}); kept the plain will.`));
  console.log(`${green('✓')} will written: ${prettyPath(r.file)} ${dim(`(${r.engine})`)}`);
}

/** /will: the agent writes its own will and pipes it here. Its word beats any summary. */
function cmdSelf(args) {
  let body = readStdin().trim();
  if (!body) {
    console.error('Pipe the will body in: wills self <<\'EOF\' … EOF');
    process.exitCode = 1;
    return;
  }
  const cfg = store.loadConfig();
  // the session that is running this command: Claude Code puts its id in the Bash tool's environment
  const sid = process.env.CLAUDE_CODE_SESSION_ID || null;
  const transcript = argFlag(args, '--transcript') || (sid && findTranscript(sid)) || (sid ? null : store.latestTranscript(process.cwd()));
  let info = { prompts: [], toolCalls: 0, startedAt: null, endedAt: new Date().toISOString(), gitBranch: null, sessionId: sid };
  if (transcript && transcript !== true && fs.existsSync(transcript)) {
    info = readTranscript(transcript);
    info.endedAt = new Date().toISOString();
  }
  body = body.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').replace(/^#\s*(last\s+)?will[^\n]*\n+/i, '').trim();
  // the Bash tool may have cd'd since the session began: the will belongs where the session started
  const cwd = process.cwd();
  const dir = store.willsDir(cwd, cfg, info.cwd);
  const root = store.projectRoot(cwd, info.cwd);
  // no epitaph: a will that opens on a section keeps the section and gets a line from its last words
  if (/^#/.test(body)) body = `> ${firstSentence(shorten(info.finalWords, root)) || 'I left no epitaph.'}\n\n${body}`;
  else if (!body.startsWith('>')) body = `> ${body.split('\n')[0]}\n${body.split('\n').slice(1).join('\n')}`.trim();
  const firstAsk = info.prompts.find((p) => !/^\/(agent-wills:)?will\b/.test(p.text));
  const meta = { id: sid || info.sessionId || require('crypto').randomUUID(), reason: 'manual', engine: 'itself', root, maxChars: Math.max(cfg.maxChars, 1800) };
  const titleFlag = argFlag(args, '--title');
  meta.title = (typeof titleFlag === 'string' ? titleFlag : firstAsk ? firstAsk.text : 'a session').replace(/\s+/g, ' ').slice(0, 60);
  const file = store.willPathFor(dir, { id: meta.id, title: meta.title, subagent: false });
  store.ensureWillsDir(dir);
  const text = cap(redact(`${header(info, meta)}\n${body}`) + '\n', meta.maxChars);
  store.writeAtomic(file, text);
  store.removeOtherWills(file, meta.id);
  console.log(`will written: ${prettyPath(file)} (${kb(Buffer.byteLength(text))})`);
}

function findTranscript(id) {
  const base = path.join(store.CLAUDE_DIR(), 'projects');
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

// ---------------------------------------------------------------- setup

const EVENTS = [
  ['SessionStart', 'session-start', 10],
  ['SessionEnd', 'session-end', 15],
  ['SubagentStop', 'subagent-stop', 10],
];

/** --project goes to settings.local.json: the hook path is personal (it names your home folder), so it must not be committed. */
function settingsFile(project) {
  return project ? path.join(store.projectRoot(process.cwd()), '.claude', 'settings.local.json') : path.join(store.CLAUDE_DIR(), 'settings.json');
}

/** Our hook, wherever the app was copied to (AGENT_WILLS_HOME can put it in a folder with any name). */
function isOurs(h) {
  return !!h && typeof h.command === 'string' && /wills\.js"? hook (session-start|session-end|subagent-stop)\b/.test(h.command);
}

function hasOurs(settings) {
  return Object.values((settings && settings.hooks) || {}).some((groups) => Array.isArray(groups) && groups.some((g) => g && (g.hooks || []).some(isOurs)));
}

function stripOurs(settings) {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks || []).filter((h) => {
        if (isOurs(h)) {
          removed++;
          return false;
        }
        return true;
      });
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

function copyApp() {
  const src = path.join(__dirname, '..');
  const dest = path.join(store.HOME_DIR(), 'app');
  if (path.resolve(src) === path.resolve(dest)) return dest;
  fs.rmSync(dest, { recursive: true, force: true });
  for (const part of ['bin', 'src', 'commands', 'package.json', 'LICENSE', 'README.md']) {
    const from = path.join(src, part);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, part), { recursive: true });
  }
  return dest;
}

function pluginInstalled() {
  const j = store.readJSON(path.join(store.CLAUDE_DIR(), 'plugins', 'installed_plugins.json'), null);
  return !!(j && JSON.stringify(j).includes('agent-wills'));
}

function cmdInstall(args) {
  const project = !!argFlag(args, '--project');
  const engine = argFlag(args, '--engine');
  if (engine && engine !== true) store.saveConfig({ engine });
  const app = copyApp();
  const script = path.join(app, 'bin', 'wills.js');
  const node = onPath('node') ? 'node' : process.execPath;
  const file = settingsFile(project);
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      settings = JSON.parse(raw || '{}');
    } catch {
      console.error(red(`${prettyPath(file)} is not valid JSON; fix it first, I won't overwrite it.`));
      process.exitCode = 1;
      return;
    }
    const bak = `${file}.agent-wills.bak`;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw);
  }
  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  for (const [ev, name, timeout] of EVENTS) {
    settings.hooks[ev] = settings.hooks[ev] || [];
    settings.hooks[ev].push({ hooks: [{ type: 'command', command: `${node} "${script}" hook ${name}`, timeout }] });
  }
  store.writeAtomic(file, JSON.stringify(settings, null, 2) + '\n');

  if (!project) {
    const cmdDir = path.join(store.CLAUDE_DIR(), 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    const tpl = fs.readFileSync(path.join(app, 'commands', 'will.md'), 'utf8').split('${CLAUDE_PLUGIN_ROOT}').join(app);
    const dest = path.join(cmdDir, 'will.md');
    if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes('agent-wills')) {
      console.log(red(`  ${prettyPath(dest)} already exists and isn't ours; left it alone, so there's no /will command.`));
    } else {
      fs.writeFileSync(dest, tpl);
    }
  }
  const cfg = store.loadConfig();
  console.log(`${green('✓')} Agent Wills installed ${dim(`(hooks in ${prettyPath(file)}${project ? '' : ', /will command'})`)}`);
  console.log(`  When a session or subagent ends, it leaves a will in ${dim('.claude/wills/')}; the next session inherits it.`);
  console.log(`  Wills are written by: ${bold(describeEngine(cfg))}`);
  if (pluginInstalled()) console.log(red('  Note: the agent-wills plugin is also installed. Use one or the other (wills uninstall, or /plugin uninstall).'));
  console.log(dim('  Restart Claude Code to pick up the hooks. Check anytime with: wills doctor'));
}

function cmdUninstall(args) {
  const project = !!argFlag(args, '--project');
  const file = settingsFile(project);
  if (!fs.existsSync(file)) return console.log('Nothing to remove.');
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch {
    console.error(red(`${prettyPath(file)} is not valid JSON; not touching it.`));
    process.exitCode = 1;
    return;
  }
  const n = stripOurs(settings);
  store.writeAtomic(file, JSON.stringify(settings, null, 2) + '\n');
  const cmd = path.join(store.CLAUDE_DIR(), 'commands', 'will.md');
  if (!project && fs.existsSync(cmd) && fs.readFileSync(cmd, 'utf8').includes('agent-wills')) fs.unlinkSync(cmd);
  console.log(`${green('✓')} removed ${n} hook${n === 1 ? '' : 's'} from ${prettyPath(file)}. Your wills stay where they are.`);
}

function describeEngine(cfg) {
  const e = resolveEngine(cfg);
  const via = cfg.engine === 'auto' ? 'auto → ' : '';
  if (e === 'publik') return `${via}publik (${cfg.publikModel}, your publik key)`;
  if (e === 'claude') return `${via}your own Claude Code (claude -p, ${cfg.claudeModel})`;
  if (e === 'byo') return `${via}your own key (${cfg.byoModel} at ${cfg.byoBaseUrl})`;
  return `${via}plain (no model; nothing leaves this machine)`;
}

function cmdDoctor() {
  const cfg = store.loadConfig();
  const ok = (s) => console.log(`  ${green('✓')} ${s}`);
  const warn = (s) => console.log(`  ${gold('!')} ${s}`);
  const bad = (s) => console.log(`  ${red('✗')} ${s}`);
  console.log(bold(`Agent Wills ${VERSION}`));
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 18 ? ok : bad)(`node ${process.versions.node}${major >= 18 ? '' : ' (need 18+)'}`);
  const user = store.readJSON(settingsFile(false), {});
  const proj = store.readJSON(settingsFile(true), {});
  const has = hasOurs;
  const sources = [];
  if (pluginInstalled()) sources.push('plugin');
  if (has(user)) sources.push('~/.claude/settings.json');
  if (has(proj)) sources.push('this project’s .claude/settings.local.json');
  if (!sources.length) bad('hooks: not installed. Run: npx github:VedSoni-dev/agent-wills install (or /plugin install agent-wills)');
  else if (sources.length > 1) warn(`hooks: installed twice (${sources.join(' + ')}); keep one`);
  else ok(`hooks: ${sources[0]}`);
  ok(`engine: ${describeEngine(cfg)}`);
  if (publikKey()) ok('publik key: found');
  else console.log(`  ${dim('·')} publik key: none ${dim('(optional; put one in ~/.config/publik/key for free will-writing credit)')}`);
  if (resolveEngine(cfg) === 'claude' && !onPath('claude')) bad('claude: not on PATH');
  const dir = store.willsDir(process.cwd(), cfg);
  const n = loadWills(dir).length;
  ok(`wills here: ${n} in ${prettyDir(dir)}`);
  const err = store.lastError();
  if (err) bad(`last error (${err.at}): ${err.message}${err.topUpUrl ? ` → add credit: ${err.topUpUrl}` : ''}`);
  console.log(dim(`  subagent wills: ${cfg.subagents} · estate at start-up: ${cfg.estate ? 'on' : 'off'} · config: ${prettyPath(path.join(store.HOME_DIR(), 'config.json'))}`));
}

const CONFIG_KEYS = {
  engine: ['auto', 'publik', 'claude', 'byo', 'plain'],
  subagents: ['plain', 'model', 'off'],
  location: ['project', 'home'],
  estate: ['true', 'false'],
  scripted: ['true', 'false'],
  claudeModel: null,
  publikModel: null,
  byoBaseUrl: null,
  byoModel: null,
  maxChars: null,
};

function cmdConfig(args) {
  const [key, value] = args;
  if (!key) {
    const cfg = store.loadConfig();
    for (const k of Object.keys(CONFIG_KEYS)) console.log(`${k.padEnd(12)} ${cfg[k]}`);
    return;
  }
  if (!(key in CONFIG_KEYS)) {
    console.error(`unknown key "${key}". keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (value === undefined) return console.log(store.loadConfig()[key]);
  const allowed = CONFIG_KEYS[key];
  if (allowed && !allowed.includes(value)) {
    console.error(`${key} must be one of: ${allowed.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  let v = value;
  if (key === 'estate' || key === 'scripted') v = value === 'true';
  if (key === 'maxChars') v = Math.min(2000, Math.max(400, Number(value) || 1400));
  store.saveConfig({ [key]: v });
  console.log(`${key} = ${v}`);
}

// ---------------------------------------------------------------- misc

function prettyPath(p) {
  const cwd = process.cwd();
  if (p.startsWith(cwd + path.sep)) return path.relative(cwd, p);
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function prettyDir(d) {
  return prettyPath(d) + '/';
}

function help() {
  console.log(`${bold('wills')} ${dim(VERSION)}: when an agent dies, it leaves a will. The next one inherits it.

  ${bold('wills')}                    list the wills in this folder
  ${bold('wills read')} [n|id]        read one (default: the newest)
  ${bold('wills estate')}             what the next agent will be told at start-up
  ${bold('wills recall')} <words>     search every will here
  ${bold('wills write')} [--engine e] write a will now for this folder's latest session
  ${bold('wills install')} [--project] [--engine auto|publik|claude|plain]
  ${bold('wills uninstall')} [--project]
  ${bold('wills doctor')}             check the setup
  ${bold('wills config')} [key] [value]

${dim('Wills live in <repo>/.claude/wills/ (git-ignored by default). Docs: github.com/VedSoni-dev/agent-wills')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case undefined:
    case 'list':
    case 'ls':
      return cmdList(args);
    case 'read':
    case 'cat':
      return cmdRead(args);
    case 'estate':
      return cmdEstate();
    case 'recall':
    case 'search':
      return cmdRecall(args);
    case 'write':
      return cmdWrite(args);
    case 'self':
      return cmdSelf(args);
    case 'install':
      return cmdInstall(args);
    case 'uninstall':
      return cmdUninstall(args);
    case 'doctor':
      return cmdDoctor();
    case 'config':
      return cmdConfig(args);
    case 'hook':
      return hook(args[0]);
    case '_refine':
      return runJob(args[0]);
    case '--version':
    case '-v':
      return console.log(VERSION);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      console.error(`unknown command "${cmd}"\n`);
      help();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  if (process.argv[2] === 'hook' || process.argv[2] === '_refine') hookLog(`${process.argv[2]} crashed: ${e.stack || e.message}`);
  else console.error(red(e.message));
  process.exitCode = process.argv[2] === 'hook' ? 0 : 1;
});
