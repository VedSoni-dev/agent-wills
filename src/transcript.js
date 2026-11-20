'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** Long text keeps its start and its end: an agent's last message usually closes on what is left. */
function clipEnds(s, n, tail = Math.round(n * 0.4)) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const end = s.slice(-tail).replace(/^\S*\s+/, '');
  return `${clip(s, n - end.length - 1)} ${end}`;
}

// What a human actually typed, minus harness noise. Slash commands become "/name args".
function cleanPrompt(text) {
  let s = String(text || '').replace(REMINDER_RE, '');
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    s = `${cmd[1].trim()} ${args.trim()}`;
  }
  if (/^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)/.test(s)) return '';
  s = s.replace(/<\/?(command-message|command-args|bash-input)>/g, '');
  if (/^\s*Caveat: The messages below were generated/i.test(s)) return '';
  if (/^\s*\[Request interrupted by user/.test(s)) return '';
  return s.trim();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toolSummary(name, input) {
  input = input || {};
  if (input.file_path) return input.file_path;
  if (input.notebook_path) return input.notebook_path;
  if (input.command) return clip(redact(input.command), 160);
  if (input.pattern) return clip(input.pattern, 80);
  if (input.url) return clip(input.url, 120);
  if (input.description) return clip(input.description, 100);
  if (input.query) return clip(input.query, 100);
  return '';
}

/**
 * Read a Claude Code transcript (.jsonl) into the facts a will needs.
 * Never throws on a bad line: a corrupt record is skipped, not fatal.
 */
function readTranscript(file, opts = {}) {
  const sidechain = !!opts.sidechain;
  const raw = fs.readFileSync(file, 'utf8');
  const info = {
    file,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    model: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    notes: [],
    finalWords: '',
    compactSummary: '',
    edited: new Map(),
    read: new Map(),
    commands: [],
    errors: [],
    toolCalls: 0,
    lastToolAt: null,
    entrypoint: null,
    activeMs: 0,
  };
  const pendingTools = new Map();
  let lastTs = 0;

  for (const line of raw.split('\n')) {
    if (!line || (line.indexOf('"type":"user"') === -1 && line.indexOf('"type":"assistant"') === -1)) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!sidechain && o.isSidechain) continue;
    if (o.sessionId && !info.sessionId) info.sessionId = o.sessionId;
    if (o.cwd && !info.cwd) info.cwd = o.cwd;
    if (o.gitBranch) info.gitBranch = o.gitBranch;
    if (o.entrypoint && !info.entrypoint) info.entrypoint = o.entrypoint;
    if (o.timestamp) {
      if (!info.startedAt) info.startedAt = o.timestamp;
      info.endedAt = o.timestamp;
      // active time: gaps over 10 minutes (a lunch break, a resume next day) count as 10
      const t = Date.parse(o.timestamp);
      if (t && lastTs) info.activeMs += Math.min(Math.max(0, t - lastTs), 10 * 60000);
      if (t) lastTs = t;
    }
    const m = o.message;
    if (!m) continue;

    if (o.type === 'user') {
      if (o.isMeta) continue;
      if (o.isCompactSummary) {
        info.compactSummary = clip(redact(textOf(m.content).replace(REMINDER_RE, '')), 3000);
        continue;
      }
      // background notifications, scheduled triggers and subagent hand-backs arrive as user
      // records; only what a human typed counts as a prompt
      const human = o.promptSource !== 'system' && !(o.origin && o.origin.kind && o.origin.kind !== 'human');
      if (typeof m.content === 'string') {
        const p = human ? cleanPrompt(m.content) : '';
        if (p) info.prompts.push({ text: redact(p), at: o.timestamp });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      const typed = [];
      for (const c of m.content) {
        if (!c) continue;
        if (c.type === 'text') {
          const p = human ? cleanPrompt(c.text) : '';
          if (p) typed.push(redact(p));
        } else if (c.type === 'tool_result') {
          const t = pendingTools.get(c.tool_use_id);
          if (c.is_error) {
            const msg = clip(redact(textOf(c.content)), 240);
            if (msg && !/^(The user doesn't want|User rejected|Permission to use)/i.test(msg)) {
              info.errors.push({ tool: t ? t.name : 'tool', what: t ? t.summary : '', msg });
            }
            if (t && t.cmd) t.cmd.failed = true;
          }
        }
      }
      if (typed.length) info.prompts.push({ text: typed.join('\n'), at: o.timestamp });
      continue;
    }

    // assistant
    if (m.model && !String(m.model).startsWith('<')) info.model = m.model;
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (!c) continue;
      if (c.type === 'text' && c.text && c.text.trim()) {
        const t = redact(c.text.replace(REMINDER_RE, '')).trim();
        if (t) {
          info.notes.push(t);
          info.finalWords = t;
        }
      } else if (c.type === 'tool_use') {
        info.toolCalls++;
        if (o.timestamp) info.lastToolAt = o.timestamp;
        const name = c.name || 'tool';
        const input = c.input || {};
        const summary = toolSummary(name, input);
        const entry = { name, summary };
        if (EDIT_TOOLS.has(name) && summary) {
          info.edited.set(summary, (info.edited.get(summary) || 0) + 1);
        } else if (READ_TOOLS.has(name) && summary) {
          info.read.set(summary, (info.read.get(summary) || 0) + 1);
        } else if (name === 'Bash' && input.command) {
          entry.cmd = { cmd: clip(redact(input.command), 160), failed: false };
          info.commands.push(entry.cmd);
        }
        if (c.id) pendingTools.set(c.id, entry);
      }
    }
  }
  return info;
}

function minutesBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Absolute paths eat tokens: make them project-relative (or ~) inside free text.
 *  Only whole path components match: /work/app never touches /work/app-api. */
function shorten(text, root) {
  let s = String(text || '');
  if (root && root.length > 1) {
    s = s.replace(new RegExp(esc(root + path.sep), 'g'), '');
    s = s.replace(new RegExp(esc(root) + '(?![\\w.-])', 'g'), '.');
  }
  const home = require('os').homedir();
  if (home && home.length > 1) s = s.replace(new RegExp(esc(home) + '(?=/|(?![\\w.-]))', 'g'), '~');
  return s;
}

function rel(p, root) {
  if (!p) return p;
  if (root && p.startsWith(root + path.sep)) return p.slice(root.length + 1);
  const home = require('os').homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

/** A died-young session leaves no will: nothing was asked, or nothing happened. */
function isTrivial(info, { subagent = false } = {}) {
  if (subagent) return info.toolCalls === 0 && (info.finalWords || '').length < 200;
  if (!info.prompts.length) return true;
  return info.toolCalls === 0 && info.prompts.length < 3;
}

/** The condensed, redacted record a model reads to write the will. */
function digest(info, meta = {}) {
  const root = meta.root || info.cwd;
  const lines = [];
  const mins = minutesBetween(info.startedAt, info.endedAt);
  lines.push(`Project: ${meta.project || path.basename(root || '.')}${info.gitBranch ? ` (branch ${info.gitBranch})` : ''}`);
  lines.push(`Session: ${mins} min, ${info.prompts.length} prompts, ${info.toolCalls} tool calls${meta.agentType ? `, subagent type ${meta.agentType}` : ''}`);
  if (meta.cause) lines.push(`Ended because: ${meta.cause}`);
  if (meta.task) lines.push(`Task given: ${clip(meta.task, 600)}`);
  if (info.compactSummary) lines.push(`Earlier context (compacted): ${info.compactSummary}`);
  if (info.prompts.length) {
    lines.push(`First ask: ${clip(info.prompts[0].text, 900)}`);
    const later = info.prompts.slice(1).slice(-10);
    if (later.length) {
      lines.push('Later asks (oldest first):');
      for (const p of later) lines.push(`- ${clip(p.text, 400)}`);
    }
  }
  const edited = [...info.edited.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (edited.length) lines.push('Files edited: ' + edited.map(([f, n]) => `${rel(f, root)}${n > 1 ? ` ×${n}` : ''}`).join(', '));
  const read = [...info.read.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (read.length) lines.push('Files read: ' + read.map(([f]) => rel(f, root)).join(', '));
  const cmds = info.commands.slice(-15);
  if (cmds.length) {
    lines.push('Commands (last 15, ✗ = failed):');
    for (const c of cmds) lines.push(`- ${c.failed ? '✗ ' : ''}${c.cmd}`);
  }
  const errs = info.errors.slice(-6);
  if (errs.length) {
    lines.push('Errors seen (last 6):');
    for (const e of errs) lines.push(`- ${e.tool}${e.what ? ` ${clip(e.what, 80)}` : ''}: ${e.msg}`);
  }
  const notes = info.notes.slice(0, -1).slice(-30);
  if (notes.length) {
    lines.push('Your notes along the way (oldest first):');
    for (const n of notes) lines.push(`- ${clip(n, 280)}`);
  }
  if (info.finalWords) lines.push(`Your final words: ${clip(info.finalWords, 1500)}`);
  let out = redact(shorten(lines.join('\n'), root));
  const CAP = 22000;
  if (out.length > CAP) out = out.slice(0, 6000) + '\n…\n' + out.slice(-(CAP - 6000));
  return out;
}

module.exports = { readTranscript, digest, isTrivial, cleanPrompt, clip, clipEnds, minutesBetween, rel, shorten };
