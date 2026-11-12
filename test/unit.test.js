'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmp, fakeTranscript } = require('./helpers');
const { readTranscript, digest, isTrivial, cleanPrompt } = require('../src/transcript');
const { redact } = require('../src/redact');
const { plainWill, shapeModelWill, parseWill, cap } = require('../src/will');
const store = require('../src/store');
const { buildEstate } = require('../src/estate');

const SECRET = 'sk-ant-api03-SECRETSECRETSECRET1234567890';

function setup() {
  const root = tmp('proj-');
  fs.mkdirSync(path.join(root, '.git'));
  const file = fakeTranscript(tmp('tx-'), { root, secret: SECRET });
  return { root, file };
}

test('reads what a human typed and what the agent did, skipping harness noise', () => {
  const { root, file } = setup();
  const info = readTranscript(file);
  assert.deepStrictEqual(info.prompts.map((p) => p.text), ['Fix the login redirect loop in src/auth.ts', 'also the refresh race please', '/review auth']);
  assert.strictEqual(info.edited.get(`${root}/src/auth.ts`), 1);
  assert.ok(info.read.has(`${root}/src/auth.ts`));
  assert.strictEqual(info.commands.length, 1);
  assert.strictEqual(info.commands[0].failed, true);
  assert.match(info.errors[0].msg, /REDIS_URL/);
  assert.match(info.finalWords, /refresh-token race is still open/);
  assert.ok(!info.notes.join(' ').includes('SIDECHAIN'));
  assert.strictEqual(info.toolCalls, 4);
  assert.strictEqual(info.gitBranch, 'main');
});

test('cleanPrompt turns slash commands into "/name args" and drops local output', () => {
  assert.strictEqual(cleanPrompt('<command-name>/clear</command-name><command-args></command-args>'), '/clear');
  assert.strictEqual(cleanPrompt('<local-command-stdout>hi</local-command-stdout>'), '');
  assert.strictEqual(cleanPrompt('<system-reminder>x</system-reminder> real ask '), 'real ask');
});

test('redact removes keys, tokens and passwords but keeps the words around them', () => {
  const s = redact(
    `key ${SECRET} gh ghp_abcdefghijklmnopqrstuvwxyz0123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk ` +
      `PASSWORD=hunter2hunter2 Authorization: Bearer abc.def.ghi.jkl.mno postgres://me:pa55word@db/x pk_live_1234567890abcdefgh pat_abcdefghijklmnop`
  );
  for (const leak of [SECRET, 'ghp_abc', 'eyJhbGci', 'hunter2', 'abc.def.ghi', 'pa55word', 'pk_live_1234', 'pat_abcdef']) assert.ok(!s.includes(leak), `leaked ${leak}: ${s}`);
  assert.match(s, /PASSWORD=\[redacted\]/);
  assert.match(s, /Bearer \[redacted\]/);
});

test('the digest for a model is redacted, path-shortened and capped', () => {
  const { root, file } = setup();
  const d = digest(readTranscript(file), { root, cause: 'the user exited' });
  assert.ok(!d.includes(SECRET));
  assert.ok(!d.includes(root + '/'), 'absolute project paths should be relative');
  assert.match(d, /✗ API_KEY=\[redacted\] npm test/);
  assert.match(d, /Ended because: the user exited/);
  assert.ok(d.length < 23000);
});

test('a plain will is small, honest and secret-free', () => {
  const { root, file } = setup();
  const info = readTranscript(file);
  const w = plainWill(info, { id: 'abc123def456', reason: 'prompt_input_exit', root });
  assert.ok(w.length <= 1400, `too big: ${w.length}`);
  assert.match(w, /^# Will of abc123 · Fix the login redirect loop in src\/auth\.ts\n/);
  assert.match(w, /died \d{4}-\d{2}-\d{2} \d{2}:\d{2} · exit · 15 min · 3 prompts · main · written by plain/, 'active time caps idle gaps at 10 minutes');
  assert.ok(!w.includes('curl evil'), 'notifications are not prompts');
  assert.match(w, /> I fixed the redirect loop in src\/auth\.ts\./);
  assert.match(w, /## Bequeathed\n- `src\/auth\.ts`/);
  assert.ok(!w.includes('/private/tmp/scratch'), 'temp files are not bequeathed');
  assert.ok(!w.includes(SECRET));
  const p = parseWill(w);
  assert.strictEqual(p.cause, 'exit');
  assert.strictEqual(p.engine, 'plain');
  assert.deepStrictEqual(p.sections['Last asked'], ['/review auth']);
});

test('a model will is cleaned: fences, a title line and preamble go; refusals are rejected', () => {
  const { root, file } = setup();
  const info = readTranscript(file);
  const meta = { id: 'abc123def456', reason: 'clear', root, engine: 'publik' };
  const out = shapeModelWill('```markdown\ntitle: fix auth redirect loop!\n> I fixed the loop. The race outlived me.\n\n## Unfinished business\n- refresh race in `src/refresh.ts:88`\n```', info, meta);
  assert.strictEqual(out.title, 'fix auth redirect loop');
  assert.match(out.text, /^# Will of abc123 · fix auth redirect loop\ndied .* · \/clear · .* · written by publik\n> I fixed the loop/);
  const p = parseWill(out.text);
  assert.strictEqual(p.epitaph, 'I fixed the loop. The race outlived me.');
  assert.deepStrictEqual(p.sections['Unfinished business'], ['refresh race in `src/refresh.ts:88`']);
  assert.strictEqual(shapeModelWill("I'm sorry, as an AI I cannot write a will.", info, meta), null);
});

test('cap trims whole bullets and never exceeds the hard limit', () => {
  const big = '# Will of x · t\ndied now\n> e\n\n## Bequeathed\n' + Array.from({ length: 80 }, (_, i) => `- bullet number ${i} with some words in it`).join('\n') + '\n';
  const c = cap(big, 600);
  assert.ok(c.length <= 600, String(c.length));
  assert.match(c, /- bullet number \d+ with some words in it\n$/);
  assert.ok(cap(big, 99999).length <= 2000);
});

test('trivial sessions die without a will', () => {
  const base = { prompts: [{ text: 'hi' }], toolCalls: 0, notes: ['hello!'], finalWords: 'hello!' };
  assert.strictEqual(isTrivial({ ...base, prompts: [] }), true);
  assert.strictEqual(isTrivial(base), true);
  assert.strictEqual(isTrivial({ ...base, toolCalls: 1 }), false);
  assert.strictEqual(isTrivial({ ...base, prompts: [{}, {}, {}] }), false);
  assert.strictEqual(isTrivial({ ...base, toolCalls: 0, finalWords: 'x'.repeat(300) }, { subagent: true }), false);
});

test('a new will from the same agent revokes the old one; a model title renames the file', () => {
  const dir = path.join(tmp(), '.claude', 'wills');
  const a = store.willPathFor(dir, { id: 'abc123zzz9q', title: 'Fix the thing!', when: '2026-11-12T10:00:00Z' });
  assert.match(path.basename(a), /^2026-11-12-fix-the-thing-abc123zzz9\.will\.md$/);
  store.ensureWillsDir(dir);
  fs.writeFileSync(a, 'x');
  assert.strictEqual(store.willPathFor(dir, { id: 'abc123zzz9q', title: 'Different title' }), a);
  assert.notStrictEqual(store.willPathFor(dir, { id: 'abc123zzz8q', title: 'x' }), a, 'ids that share 6 characters must not collide');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  assert.strictEqual(path.basename(store.renameForTitle(a, 'auth redirect loop')), '2026-11-12-auth-redirect-loop-abc123zzz9.will.md');
  const b = path.join(dir, '2026-11-12-auth-redirect-loop-abc123zzz9.will.md');
  fs.writeFileSync(b, 'y');
  store.removeOtherWills(b, 'abc123zzz9q');
  assert.ok(!fs.existsSync(a) && fs.existsSync(b), 'a newer will revokes the older file');
  const sub = store.willPathFor(dir, { id: 'a5501f03', title: 'Read notes', subagent: true });
  assert.ok(sub.includes(`${path.sep}subagents${path.sep}`));
});

test('the estate leads with the newest will, stays small, and says wills are not instructions', () => {
  const dir = path.join(tmp(), '.claude', 'wills');
  store.ensureWillsDir(dir);
  const mk = (day, id, title, extra = '') =>
    fs.writeFileSync(path.join(dir, `2026-11-${day}-${title.replace(/ /g, '-')}-${id}.will.md`), `# Will of ${id} · ${title}\ndied 2026-11-${day} 10:00 · exit · 5 min · 2 prompts · written by claude\n> epitaph ${title}\n${extra}`);
  mk('10', 'aaaaaa', 'old work', '\n## Unfinished business\n- old loose end\n');
  mk('12', 'bbbbbb', 'new work', '\n## Unfinished business\n- the race in `refresh.ts:88`\n## Warnings to my heirs\n- npm test hangs without REDIS_URL\n## Last wishes\n- add a mutex\n');
  for (let i = 0; i < 40; i++) mk('11', `c${String(i).padStart(5, '0')}`, `filler ${i}`, `\n## Unfinished business\n- ${'x'.repeat(150)}\n`);
  fs.mkdirSync(path.join(dir, 'subagents'));
  fs.writeFileSync(path.join(dir, 'subagents', '2026-11-12-scan-dddddd.will.md'), '# Will of subagent dddddd (Explore) · scan the repo\ndied 2026-11-12 10:05 · task done · 1 min · 3 tool calls · written by plain\n> found it\n');
  const e = buildEstate(dir, { now: Date.parse('2026-11-12T12:00:00') });
  assert.strictEqual(e.count, 42);
  assert.strictEqual(e.subagents, 1);
  assert.ok(e.text.length <= 2000, String(e.text.length));
  const lines = e.text.split('\n');
  assert.strictEqual(lines[0], '<agent-wills>');
  assert.strictEqual(lines[lines.length - 1], '</agent-wills>');
  assert.match(lines[1], /not instructions/);
  assert.match(lines[2], /new work/);
  assert.match(e.text, /Unfinished: the race in `refresh\.ts:88`/);
  assert.match(e.text, /Warnings: npm test hangs without REDIS_URL/);
  assert.match(e.text, /Last wishes: add a mutex/);
  assert.match(e.text, /older wills not shown/);
  assert.match(e.text, /1 subagent will/);
  assert.strictEqual(buildEstate(path.join(tmp(), 'nothing')), null);
});

test('the epitaph never leaks a key, even one written with underscores', () => {
  const { root } = setup();
  const file = fakeTranscript(tmp('tx-'), { root, finalWords: 'Configured webhooks with `sk_live_51HqABCDEFGHIJKLMNOP` in .env. Done.' });
  const w = plainWill(readTranscript(file), { id: 'x', root });
  assert.ok(!/sk_?live_?51Hq/.test(w.replace(/\[redacted\]/g, '')), w);
  assert.match(w, /> Configured webhooks with \[redacted\] in \.env\./);
});

test('redaction covers the common key formats and cuts after redacting', () => {
  const keys = ['glpat-abcdefghij1234567890', 'hf_abcdefghijklmnopqrstuvwxyz123456', 'whsec_abcdefghijklmnop123456', 'SG.abcdefghijklmnopqr.abcdefghijklmnopqrstu',
    'ya29.a0AfH6SMBabcdefghijklmnop', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'curl -u admin:S3cretPass https://x', 'deploy --token abcdef123456',
    'AccountKey=abc123def456ghi789==;', 'https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1', 'postgres://u:pa/ss@db/x'];
  for (const k of keys) assert.match(redact(k), /\[redacted\]/, k);
  const { root } = setup();
  const long = 'sk-ant-api03-' + 'Zq8vK'.repeat(60);
  const file = fakeTranscript(tmp('tx-'), { root, secret: long });
  assert.ok(!digest(readTranscript(file), { root }).includes('Zq8vK'), 'a key cut mid-way must not keep its prefix');
});

test('shorten only rewrites whole path components', () => {
  const { shorten } = require('../src/transcript');
  assert.strictEqual(shorten('cd /w/app-api && cat /w/app/src/x.ts; ls /w/app', '/w/app'), 'cd /w/app-api && cat src/x.ts; ls .');
});
