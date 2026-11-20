'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { SYSTEM } = require('./will');

const PUBLIK_BASE = 'https://publikhq.com/api/v1';

function publikKey() {
  if (process.env.PUBLIK_API_KEY) return process.env.PUBLIK_API_KEY.trim();
  for (const f of [path.join(os.homedir(), '.config', 'publik', 'key'), path.join(os.homedir(), '.config', 'publik', 'agent-wills.key')]) {
    try {
      const k = fs.readFileSync(f, 'utf8').trim();
      if (k) return k;
    } catch {
      /* next */
    }
  }
  return null;
}

function onPath(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

function byoKey() {
  return (process.env.WILLS_API_KEY || '').trim() || null;
}

/** auto: publik when you have a key, else your own Claude Code, else no model at all. */
function resolveEngine(cfg) {
  const want = cfg.engine || 'auto';
  if (want !== 'auto') return want;
  if (publikKey()) return 'publik';
  if (byoKey() && cfg.byoBaseUrl && cfg.byoModel) return 'byo';
  if (onPath('claude')) return 'claude';
  return 'plain';
}

class EngineError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

async function chatCompletion({ base, key, model, user, timeoutMs = 60000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        // a will is ~300 tokens, but publik tiers can be backed by reasoning models that think first:
        // too small a budget comes back empty
        max_tokens: 2048,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    throw new EngineError(e.name === 'AbortError' ? 'timed out' : `not reachable (${e.message})`, { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (res.status === 402) {
    const err = (data && data.error) || {};
    throw new EngineError(err.message || 'balance is empty', { kind: 'balance', status: 402, topUpUrl: err.top_up_url || err.claim_url || null });
  }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || text.slice(0, 200);
    throw new EngineError(`HTTP ${res.status}: ${msg}`, { kind: res.status === 401 || res.status === 403 ? 'auth' : 'http', status: res.status });
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new EngineError('empty reply', { kind: 'empty' });
  return {
    text: Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content),
    balance: res.headers.get('x-publik-balance') || res.headers.get('x-publik-balance-micros') || null,
  };
}

function runClaude({ user, model = 'haiku', timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model,
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources', '',
      '--system-prompt', SYSTEM,
    ];
    const child = spawn(process.env.WILLS_CLAUDE_BIN || 'claude', args, {
      cwd: os.tmpdir(),
      env: { ...process.env, AGENT_WILLS_CHILD: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new EngineError('claude timed out', { kind: 'timeout' }));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new EngineError(`claude not runnable (${e.message})`, { kind: 'missing' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ text: out });
      else reject(new EngineError(`claude exited ${code}: ${(err || out).trim().slice(0, 200)}`, { kind: 'claude' }));
    });
    child.stdin.end(user);
  });
}

/** Ask the chosen engine to write the will body. Throws EngineError; callers fall back to plain. */
async function writeWithModel(engine, digestText, cfg) {
  const user = `Here is the record of your session.\n\n${digestText}\n\nWrite your will now.`;
  if (engine === 'publik') {
    const key = publikKey();
    if (!key) throw new EngineError('no publik key (set PUBLIK_API_KEY or ~/.config/publik/key)', { kind: 'auth' });
    return chatCompletion({ base: process.env.PUBLIK_API_BASE_URL || PUBLIK_BASE, key, model: cfg.publikModel || 'publik-fast', user });
  }
  if (engine === 'byo') {
    const key = byoKey();
    if (!key || !cfg.byoBaseUrl || !cfg.byoModel) throw new EngineError('byo needs WILLS_API_KEY plus byoBaseUrl and byoModel in config', { kind: 'auth' });
    return chatCompletion({ base: cfg.byoBaseUrl, key, model: cfg.byoModel, user });
  }
  if (engine === 'claude') return runClaude({ user, model: cfg.claudeModel || 'haiku' });
  throw new EngineError(`unknown engine "${engine}"`, { kind: 'config' });
}

module.exports = { resolveEngine, writeWithModel, publikKey, onPath, EngineError, PUBLIK_BASE };
