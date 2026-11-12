'use strict';

const path = require('path');
const { clip, minutesBetween, rel, shorten } = require('./transcript');
const { redact } = require('./redact');

/*
 A will is one small markdown file:

   # Will of 57b3ab · fix the oauth redirect loop
   died 2026-11-12 14:32 · exit · 41 min · 12 prompts · main · written by claude
   > I fixed the OAuth redirect loop. The refresh-token race outlived me.

   ## Bequeathed
   - ...
   ## Unfinished business
   ## Warnings to my heirs
   ## What I knew
   ## Last wishes

 The header is two lines a human reads and a regex parses. Sections with nothing
 real in them are left out, so a quiet session leaves a quiet will.
*/

const SECTIONS = ['Bequeathed', 'Unfinished business', 'Warnings to my heirs', 'What I knew', 'Last wishes'];
const PLAIN_SECTIONS = ['Bequeathed', 'Last asked', 'Last words', 'Errors seen', 'Last commands'];
const HARD_CAP = 2000;

const CAUSES = {
  clear: '/clear',
  logout: 'logout',
  prompt_input_exit: 'exit',
  other: 'closed',
  subagent: 'task done',
  manual: 'by hand',
};

function causeOf(reason) {
  return CAUSES[reason] || String(reason || 'closed').replace(/_/g, ' ');
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function titleFrom(info, meta) {
  if (meta.task) return clip(meta.task, 60);
  const first = info.prompts.find((p) => !p.text.startsWith('/') || p.text.includes(' '));
  return clip(first ? first.text.replace(/^\/\S+\s*/, '') || first.text : 'a quiet session', 60);
}

function header(info, meta) {
  const id = String(meta.id || info.sessionId || '').slice(0, 6);
  const who = meta.subagent ? `subagent ${id}${meta.agentType ? ` (${meta.agentType})` : ''}` : id;
  const title = meta.title || titleFrom(info, meta);
  const self = meta.engine === 'itself';
  const bits = self ? [`signed ${fmtDate(info.endedAt)}`] : [`died ${fmtDate(info.endedAt)}`, causeOf(meta.reason)];
  bits.push(duration(info.activeMs !== undefined ? Math.round(info.activeMs / 60000) : minutesBetween(info.startedAt, info.endedAt)));
  if (!meta.subagent) bits.push(`${info.prompts.length} prompt${info.prompts.length === 1 ? '' : 's'}`);
  else bits.push(`${info.toolCalls} tool call${info.toolCalls === 1 ? '' : 's'}`);
  if (info.gitBranch) bits.push(info.gitBranch);
  bits.push(`written by ${meta.engine || 'plain'}`);
  return `# Will of ${who} · ${title.replace(/\s+/g, ' ')}\n${bits.join(' · ')}`;
}

function duration(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h >= 10 || !m ? `${h} h` : `${h} h ${m} min`;
}

const TEMP_RE = /^(\/private)?\/(tmp|var\/folders)\//;

/** Files worth bequeathing: inside the project first, temp files never. */
function keptFiles(info, root) {
  const all = [...info.edited.entries()].sort((a, b) => b[1] - a[1]);
  const inside = all.filter(([f]) => root && f.startsWith(root + path.sep));
  const outside = all.filter(([f]) => !(root && f.startsWith(root + path.sep)) && !TEMP_RE.test(f));
  return inside.length ? inside.concat(outside.slice(0, 2)) : outside;
}

function firstSentence(s, n = 160) {
  const raw = String(s || '').trim();
  const line = raw.split('\n')[0].trim();
  if (line.length >= 20 && raw.includes('\n')) s = /:$/.test(line) ? line.replace(/:$/, '…') : line;
  const t = String(s || '').replace(/[#*`>]/g, '').replace(/(^|\n)\s*(?:[-•]|\d+[.)])\s+/g, '$1').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[^\s\d][.!?])(?=\s+[A-Z"'(]|\s*$)/);
  return clip(m ? m[1] : t, n);
}

/** The will an agent leaves when no model is around: facts only, written in ~5 ms. */
function plainWill(info, meta = {}) {
  const root = meta.root || info.cwd;
  const out = [header(info, { ...meta, engine: 'plain' })];
  const epitaph = firstSentence(shorten(info.finalWords, root)) || 'I left no last words.';
  out.push(`> ${epitaph}`);

  const edited = keptFiles(info, root);
  if (edited.length) {
    out.push('', '## Bequeathed');
    for (const [f, n] of edited.slice(0, 6)) out.push(`- \`${rel(f, root)}\`${n > 1 ? ` (edited ${n}×)` : ''}`);
    if (edited.length > 6) out.push(`- …and ${edited.length - 6} more files`);
  }
  const last = meta.subagent ? null : info.prompts[info.prompts.length - 1];
  if (last && info.prompts.length > 1) out.push('', '## Last asked', `- ${clip(last.text, 220)}`);
  if (info.finalWords && info.finalWords.length > epitaph.length + 10) {
    out.push('', '## Last words', `- ${clip(info.finalWords, 420)}`);
  }
  const errs = info.errors.slice(-3);
  if (errs.length) {
    out.push('', '## Errors seen');
    for (const e of errs) out.push(`- ${e.tool}: ${clip(e.msg, 140)}`);
  }
  const cmds = info.commands.slice(-4);
  if (cmds.length) {
    out.push('', '## Last commands');
    for (const c of cmds) out.push(`- ${c.failed ? '✗ ' : ''}\`${clip(c.cmd, 100).replace(/`/g, "'")}\``);
  }
  return cap(redact(shorten(out.join('\n'), root)) + '\n', meta.maxChars || 1400);
}

const SYSTEM = `You are a coding agent about to be shut down. Below is a condensed record of your session. Write your will: a tiny markdown handoff for the next agent who works in this folder, who will read it cold.

Output ONLY the will body, nothing before or after it, no code fences. At most 900 characters.

Line 1: "title: " then 3 to 6 words naming what this session was about: lowercase except code names, which keep their case (no punctuation).
Line 2: "> " then your epitaph: one or two short first-person sentences on what you did and what is left. Dry wit is welcome; accuracy comes first.
Then these sections, in this order. Leave out any section with nothing real in it:
## Bequeathed
(what is done and where it lives: paths, commands)
## Unfinished business
(what is left, with file:line or the exact failing command)
## Warnings to my heirs
(traps you hit: wrong assumptions, flaky commands, env needs)
## What I knew
(non-obvious facts about this project worth keeping)
## Last wishes
(the single most useful next step)

Rules: max 3 bullets per section, each under 110 characters, fragments not sentences. \`code\` for paths and commands; paths relative to the project. Only facts the record shows: never invent files, results or numbers, and leave out anything you would have to guess (git state, whether something was committed or deployed). If nothing meaningful happened, write only the title and the epitaph. Never write secrets, keys, tokens or passwords.`;

/** Turn whatever the model returned into a clean, capped will under our header. */
function shapeModelWill(raw, info, meta) {
  let body = String(raw || "").trim();
  body = body.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  body = body.replace(/^#\s*(last\s+)?will[^\n]*\n+/i, '');
  const t = body.match(/^\s*title:\s*(.+)\n/i);
  if (t) {
    meta = { ...meta, title: t[1].replace(/[^\w\s-]/g, '').trim().slice(0, 60) || meta.title };
    body = body.slice(t[0].length);
  }
  const lines = body.split('\n');
  const q = lines.findIndex((l) => l.startsWith('>'));
  if (q > 0) lines.splice(0, q);
  if (!lines.length || !lines[0].startsWith('>')) lines.unshift(`> ${firstSentence(info.finalWords) || 'I left no last words.'}`);
  body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!looksLikeWill(body)) return null;
  const text = cap(redact(`${header(info, meta)}\n${body}`) + '\n', meta.maxChars || 1400);
  return { text, title: meta.title || null };
}

function looksLikeWill(body) {
  return body.length >= 12 && body.startsWith('>') && !/as an ai|i cannot|i can't help/i.test(body.slice(0, 200));
}

/** Keep wills small: cut whole bullets from the end until it fits, never mid-word. */
function cap(text, limit = 1400) {
  limit = Math.min(Math.max(400, limit), HARD_CAP);
  if (text.length <= limit) return text;
  const lines = text.trimEnd().split('\n');
  while (lines.join('\n').length > limit - 2 && lines.length > 3) {
    lines.pop();
    while (lines.length > 3 && /^##\s/.test(lines[lines.length - 1])) lines.pop();
    while (lines.length > 3 && lines[lines.length - 1].trim() === '') lines.pop();
  }
  let out = lines.join('\n');
  if (out.length > limit) out = out.slice(0, limit - 2).replace(/\s+\S*$/, '') + '…';
  return out + '\n';
}

/** Read a will back: header fields, epitaph and sections. Tolerant of hand edits. */
function parseWill(text, file) {
  const lines = String(text || '').split('\n');
  const w = { file, title: '', who: '', died: '', cause: '', engine: '', epitaph: '', sections: {}, bytes: Buffer.byteLength(text || '') };
  const h = (lines[0] || '').match(/^#\s*Will of\s+(.+?)\s+·\s+(.*)$/);
  if (h) {
    w.who = h[1];
    w.title = h[2];
  } else if (lines[0]) {
    w.title = lines[0].replace(/^#\s*/, '');
  }
  const meta = (lines[1] || '').split(' · ');
  for (const b of meta) {
    if (b.startsWith('died ')) w.died = b.slice(5);
    else if (b.startsWith('signed ')) w.died = b.slice(7);
    else if (b.startsWith('written by ')) w.engine = b.slice(11);
  }
  if (meta[1] && !/^signed /.test(meta[0])) w.cause = meta[1];
  let cur = null;
  for (const l of lines.slice(2)) {
    if (l.startsWith('>') && !w.epitaph && !cur) {
      w.epitaph = l.replace(/^>\s*/, '').trim();
    } else if (/^##\s+/.test(l)) {
      cur = l.replace(/^##\s+/, '').trim();
      w.sections[cur] = [];
    } else if (cur && /^\s*[-*]\s+/.test(l)) {
      w.sections[cur].push(l.replace(/^\s*[-*]\s+/, '').trim());
    } else if (cur && l.trim() && w.sections[cur].length) {
      w.sections[cur][w.sections[cur].length - 1] += ' ' + l.trim();
    }
  }
  w.subagent = /^subagent\b/.test(w.who) || (file ? file.includes(`${path.sep}subagents${path.sep}`) : false);
  w.self = w.engine === 'itself';
  return w;
}

module.exports = { duration, keptFiles, plainWill, shapeModelWill, parseWill, cap, header, SYSTEM, SECTIONS, PLAIN_SECTIONS, causeOf, fmtDate, titleFrom, firstSentence };
