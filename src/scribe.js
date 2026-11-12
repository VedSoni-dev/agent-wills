'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readTranscript, digest, isTrivial } = require('./transcript');
const { plainWill, shapeModelWill, parseWill } = require('./will');
const store = require('./store');
const { resolveEngine, writeWithModel } = require('./engines');

function readMeta(agentTranscript) {
  if (!agentTranscript) return {};
  return store.readJSON(agentTranscript.replace(/\.jsonl$/, '.meta.json'), {});
}

/**
 * Gather everything needed to write one will. Returns null when the agent
 * died young (nothing asked, nothing done), so no will is written.
 */
function prepare(opts) {
  const cfg = opts.cfg || store.loadConfig();
  const subagent = !!opts.subagent;
  if (!opts.transcript || !fs.existsSync(opts.transcript)) return null;
  const info = readTranscript(opts.transcript, { sidechain: subagent });
  if (subagent && !info.finalWords && opts.lastMessage) info.finalWords = opts.lastMessage;
  if (!opts.force && isTrivial(info, { subagent })) return null;
  // scripted runs (claude -p, the Agent SDK) leave no will unless asked: they'd spend usage on every run
  if (!opts.force && !cfg.scripted && /^sdk/.test(info.entrypoint || opts.entrypoint || '')) return null;

  const cwd = opts.cwd || info.cwd || process.cwd();
  const root = store.projectRoot(cwd);
  const am = subagent ? readMeta(opts.transcript) : {};
  const meta = {
    id: subagent ? opts.agentId || am.agentId || path.basename(opts.transcript, '.jsonl').replace(/^agent-/, '') : opts.sessionId || info.sessionId,
    reason: subagent ? 'subagent' : opts.reason || 'other',
    subagent,
    agentType: opts.agentType || am.agentType || null,
    task: subagent ? am.description || (info.prompts[0] && info.prompts[0].text) || null : null,
    root,
    project: path.basename(root),
    maxChars: cfg.maxChars,
  };
  if (subagent) meta.cause = 'finished its task';
  else meta.cause = { clear: 'the user ran /clear', logout: 'the user logged out', prompt_input_exit: 'the user exited' }[meta.reason] || 'the session closed';

  const dir = store.willsDir(cwd, cfg);
  const file = store.willPathFor(dir, { id: meta.id, title: meta.task || (info.prompts[0] && info.prompts[0].text), when: info.endedAt, subagent });
  return { info, meta, dir, file, cfg, transcript: opts.transcript };
}

/** A will the agent wrote itself (via /will) beats any summary, unless work went on after it. */
function hasSelfWill(prep) {
  try {
    const text = fs.readFileSync(prep.file, 'utf8');
    if (!parseWill(text, prep.file).self) return false;
    const mtime = fs.statSync(prep.file).mtimeMs;
    const lastPrompt = prep.info.prompts.length ? Date.parse(prep.info.prompts[prep.info.prompts.length - 1].at) : 0;
    return !(lastPrompt > mtime + 1000);
  } catch {
    return false;
  }
}

function writePlain(prep) {
  if (hasSelfWill(prep)) return { file: prep.file, kept: 'itself' };
  store.ensureWillsDir(prep.dir);
  // a model will already on disk for this agent is better than a fresh plain one
  try {
    if (!/written by plain\n/.test(fs.readFileSync(prep.file, 'utf8')) && prep.info.prompts.length && !prep.forcePlain) {
      const mtime = fs.statSync(prep.file).mtimeMs;
      const last = Date.parse(prep.info.endedAt || 0);
      if (mtime >= last) return { file: prep.file, kept: 'model' };
    }
  } catch {
    /* no will yet */
  }
  store.writeAtomic(prep.file, plainWill(prep.info, prep.meta));
  return { file: prep.file, engine: 'plain' };
}

/** Rewrite the plain will with a model, in the agent's own voice. Falls back to plain on any failure. */
async function refine(prep, engine) {
  if (engine === 'plain' || hasSelfWill(prep)) return { file: prep.file, engine: 'plain' };
  try {
    const res = await writeWithModel(engine, digest(prep.info, prep.meta), prep.cfg);
    const will = shapeModelWill(res.text, prep.info, { ...prep.meta, engine });
    if (!will) throw Object.assign(new Error('the model did not write a will'), { kind: 'shape' });
    store.ensureWillsDir(prep.dir);
    const file = store.renameForTitle(store.willPathFor(prep.dir, { id: prep.meta.id, title: will.title, subagent: prep.meta.subagent }), will.title);
    store.writeAtomic(file, will.text);
    store.removeOtherWills(file, prep.meta.id);
    store.clearError();
    return { file, engine };
  } catch (e) {
    store.logError(e.kind || 'engine', `${engine}: ${e.message}`, { engine, topUpUrl: e.topUpUrl || null, will: prep.file });
    if (!fs.existsSync(prep.file)) writePlain(prep);
    return { file: prep.file, engine: 'plain', error: e };
  }
}

/** Hand the slow part to a detached process so closing Claude Code is never delayed. */
function refineLater(prep, engine, opts) {
  const jobs = path.join(store.HOME_DIR(), 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const job = path.join(jobs, `${store.shortId(prep.meta.id)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(job, JSON.stringify({ ...opts, cfg: undefined, engine }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'wills.js'), '_refine', job], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_WILLS_CHILD: '1' },
  });
  child.unref();
  return job;
}

async function runJob(jobFile) {
  const job = store.readJSON(jobFile, null);
  try {
    fs.unlinkSync(jobFile);
  } catch {
    /* already gone */
  }
  if (!job) return null;
  await new Promise((r) => setTimeout(r, 400)); // let the transcript finish flushing
  return store.withLock(store.shortId(job.agentId || job.sessionId || path.basename(jobFile)), async () => {
    const prep = prepare(job);
    if (!prep) return null;
    return refine(prep, job.engine);
  });
}

/** The hook path: plain will now (milliseconds), model will in the background. */
function onDeath(opts) {
  const cfg = store.loadConfig();
  if (opts.subagent && cfg.subagents === 'off') return null;
  const prep = prepare({ ...opts, cfg });
  if (!prep) return null;
  const res = writePlain(prep);
  if (res.kept) return res;
  const engine = opts.subagent && cfg.subagents !== 'model' ? 'plain' : resolveEngine(cfg);
  if (engine !== 'plain') refineLater(prep, engine, opts);
  return { ...res, engine, pending: engine !== 'plain' };
}

module.exports = { prepare, writePlain, refine, refineLater, runJob, onDeath, hasSelfWill };
