'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = () => process.env.AGENT_WILLS_HOME || path.join(os.homedir(), '.agent-wills');
/** Claude Code's own folder: ~/.claude unless CLAUDE_CONFIG_DIR moves it. */
const CLAUDE_DIR = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const DEFAULTS = {
  engine: 'auto', // auto | publik | claude | byo | plain
  subagents: 'plain', // plain | model | off
  location: 'project', // project (<repo>/.claude/wills) | home (~/.agent-wills/estates/<repo>)
  estate: true, // inject the estate into new sessions
  scripted: false, // also write wills for (and hand estates to) claude -p / Agent SDK runs
  claudeModel: 'haiku',
  publikModel: 'publik-fast',
  byoBaseUrl: '',
  byoModel: '',
  maxChars: 1400,
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename. Follows symlinks (dotfile setups) and keeps the file's mode. */
function writeAtomic(file, text) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = null;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

/** One writer per agent at a time (a mkdir lock), so two endings of one session can't leave two wills. */
async function withLock(key, fn, { waitMs = 90000, staleMs = 180000 } = {}) {
  const dir = path.join(HOME_DIR(), 'locks', `${key}.lock`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > until) throw new Error(`lock ${key} busy`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** After a will is written, any other file for the same agent is a revoked will. */
function removeOtherWills(file, id) {
  const folder = path.dirname(file);
  const sid = shortId(id);
  try {
    for (const f of fs.readdirSync(folder)) {
      const full = path.join(folder, f);
      if (f.endsWith(`-${sid}.will.md`) && full !== file) fs.rmSync(full, { force: true });
    }
  } catch {
    /* folder gone */
  }
}

function configFile() {
  return path.join(HOME_DIR(), 'config.json');
}

function loadConfig() {
  const cfg = { ...DEFAULTS, ...readJSON(configFile(), {}) };
  if (process.env.WILLS_ENGINE) cfg.engine = process.env.WILLS_ENGINE;
  if (process.env.WILLS_SUBAGENTS) cfg.subagents = process.env.WILLS_SUBAGENTS;
  return cfg;
}

function saveConfig(patch) {
  const cur = readJSON(configFile(), {});
  const next = { ...cur, ...patch };
  writeAtomic(configFile(), JSON.stringify(next, null, 2) + '\n');
  return { ...DEFAULTS, ...next };
}

function gitRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The folder a will belongs to: the git root above cwd. With no git, the folder the session
 * started in (an agent that ran `cd src` must not leave its will in src/), else cwd itself.
 */
function projectRoot(cwd, startCwd) {
  const here = path.resolve(cwd || process.cwd());
  const git = gitRoot(here);
  if (git) return git;
  if (startCwd) {
    const start = path.resolve(startCwd);
    if (here === start || here.startsWith(start + path.sep)) return start;
  }
  return here;
}

function slugPath(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function willsDir(cwd, cfg = loadConfig(), startCwd) {
  if (process.env.WILLS_DIR) return path.resolve(process.env.WILLS_DIR);
  const root = projectRoot(cwd, startCwd);
  if (cfg.location === 'home') return path.join(HOME_DIR(), 'estates', slugPath(root));
  return path.join(root, '.claude', 'wills');
}

/** First will in a folder also writes a .gitignore so nothing is committed by accident. */
function ensureWillsDir(dir) {
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (fresh && path.basename(dir) === 'wills' && path.basename(path.dirname(dir)) === '.claude') {
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      '# Agent Wills: kept out of git by default. Delete this file to share wills with your team.\n*\n'
    );
  }
  return dir;
}

function slugify(s, max = 40) {
  const slug = String(s || '')
    .toLowerCase()
    .replace(/[`'"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'session';
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  return cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
}

/** 10 characters of the id in every filename: 6 collided once a project had a few hundred subagent wills. */
function shortId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'anon';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A new will from the same agent revokes the old one: same id, same file. */
function willPathFor(dir, { id, title, when, subagent }) {
  const folder = subagent ? path.join(dir, 'subagents') : dir;
  const sid = shortId(id);
  const existing = findWill(folder, sid);
  if (existing) return existing;
  return path.join(folder, `${stamp(when ? new Date(when) : new Date())}-${slugify(title)}-${sid}.will.md`);
}

/** Once a model names the session, the file gets the better name too (same date, same id). */
function renameForTitle(file, title) {
  if (!title) return file;
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})-.*-([A-Za-z0-9]+)\.will\.md$/);
  if (!m) return file;
  return path.join(path.dirname(file), `${m[1]}-${slugify(title)}-${m[2]}.will.md`);
}

function findWill(folder, sid) {
  try {
    const hit = fs.readdirSync(folder).find((f) => f.endsWith(`-${sid}.will.md`));
    return hit ? path.join(folder, hit) : null;
  } catch {
    return null;
  }
}

function listWillFiles(dir) {
  const out = [];
  for (const [folder, subagent] of [
    [dir, false],
    [path.join(dir, 'subagents'), true],
  ]) {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith('.will.md')) out.push({ file: path.join(folder, n), subagent });
  }
  return out;
}

/** Where Claude Code keeps this folder's transcripts. */
function transcriptsDir(cwd) {
  return path.join(CLAUDE_DIR(), 'projects', slugPath(path.resolve(cwd || process.cwd())));
}

/** Every session transcript in a folder, newest first. */
function transcriptsIn(dir) {
  const out = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      const st = fs.statSync(f);
      if (st.isFile()) out.push({ file: f, id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size });
    }
  } catch {
    /* no transcripts here */
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The newest transcript for this folder; from a subfolder, the nearest folder above that has one (up to the repo root). */
function latestTranscript(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  const top = projectRoot(dir);
  for (;;) {
    const found = transcriptsIn(transcriptsDir(dir))[0];
    if (found) return found.file;
    const up = path.dirname(dir);
    if (dir === top || up === dir) return null;
    dir = up;
  }
}

function logError(kind, message, extra = {}) {
  try {
    writeAtomic(
      path.join(HOME_DIR(), 'last-error.json'),
      JSON.stringify({ at: new Date().toISOString(), kind, message, ...extra }, null, 2) + '\n'
    );
  } catch {
    /* never let logging kill a will */
  }
}

function clearError() {
  try {
    fs.unlinkSync(path.join(HOME_DIR(), 'last-error.json'));
  } catch {
    /* fine */
  }
}

function lastError() {
  return readJSON(path.join(HOME_DIR(), 'last-error.json'), null);
}

module.exports = {
  HOME_DIR,
  CLAUDE_DIR,
  gitRoot,
  transcriptsIn,
  DEFAULTS,
  loadConfig,
  saveConfig,
  projectRoot,
  willsDir,
  ensureWillsDir,
  slugify,
  shortId,
  willPathFor,
  findWill,
  renameForTitle,
  listWillFiles,
  transcriptsDir,
  latestTranscript,
  writeAtomic,
  withLock,
  removeOtherWills,
  readJSON,
  logError,
  clearError,
  lastError,
  slugPath,
};
