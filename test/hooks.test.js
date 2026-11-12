'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmp, fakeTranscript, run, mockPublik, waitFor } = require('./helpers');

function project() {
  const root = tmp('proj-');
  fs.mkdirSync(path.join(root, '.git'));
  const home = tmp('home-');
  const env = { AGENT_WILLS_HOME: path.join(home, '.agent-wills'), HOME: home, PUBLIK_API_KEY: '', WILLS_ENGINE: 'plain' };
  return { root, home, env, wills: path.join(root, '.claude', 'wills'), transcript: fakeTranscript(tmp('tx-'), { root }) };
}

const willsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.will.md')) : []);

test('SessionEnd writes a will, SessionStart hands it to the next session', async () => {
  const p = project();
  const end = await run(['hook', 'session-end'], { env: p.env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root, reason: 'prompt_input_exit' }) });
  assert.strictEqual(end.code, 0);
  assert.strictEqual(end.out, '', 'SessionEnd must stay silent');
  const files = willsIn(p.wills);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /-abc123def4\.will\.md$/);

  const start = await run(['hook', 'session-start'], { env: p.env, input: JSON.stringify({ session_id: 'next', cwd: p.root, source: 'startup' }) });
  const out = JSON.parse(start.out);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /^<agent-wills>\n1 earlier agent session in this folder left a will/);
  assert.match(out.hookSpecificOutput.additionalContext, /Fix the login redirect loop/);
  assert.match(out.systemMessage, /Inherited 1 will/);

  const resume = await run(['hook', 'session-start'], { env: p.env, input: JSON.stringify({ cwd: p.root, source: 'resume' }) });
  assert.strictEqual(resume.out, '', 'a resumed session already remembers');
});

test('hooks stay silent and harmless when they have nothing to do or bad input', async () => {
  const p = project();
  const empty = await run(['hook', 'session-start'], { env: p.env, input: JSON.stringify({ cwd: p.root, source: 'startup' }) });
  assert.strictEqual(empty.out, '');
  const junk = await run(['hook', 'session-end'], { env: p.env, input: 'not json' });
  assert.strictEqual(junk.code, 0);
  const missing = await run(['hook', 'session-end'], { env: p.env, input: JSON.stringify({ transcript_path: '/nope.jsonl', cwd: p.root }) });
  assert.strictEqual(missing.code, 0);
  assert.strictEqual(willsIn(p.wills).length, 0);
  const child = await run(['hook', 'session-end'], { env: { ...p.env, AGENT_WILLS_CHILD: '1' }, input: JSON.stringify({ session_id: 'x', transcript_path: p.transcript, cwd: p.root }) });
  assert.strictEqual(child.code, 0);
  assert.strictEqual(willsIn(p.wills).length, 0, 'the will-writer must never write wills about itself');
});

test('SubagentStop leaves a plain will in subagents/, named after its task', async () => {
  const p = project();
  const agentTx = fakeTranscript(tmp('sub-'), { root: p.root, sessionId: 'agent-a5501f03d7' });
  fs.writeFileSync(agentTx.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the auth bug' }));
  const r = await run(['hook', 'subagent-stop'], {
    env: p.env,
    input: JSON.stringify({ agent_id: 'a5501f03d7', agent_type: 'Explore', agent_transcript_path: agentTx, cwd: p.root, last_assistant_message: 'done' }),
  });
  assert.strictEqual(r.code, 0);
  const subs = willsIn(path.join(p.wills, 'subagents'));
  assert.deepStrictEqual(subs.length, 1);
  assert.match(subs[0], /find-the-auth-bug-a5501f03d7\.will\.md$/);
  const text = fs.readFileSync(path.join(p.wills, 'subagents', subs[0]), 'utf8');
  assert.match(text, /^# Will of subagent a5501f \(Explore\) · Find the auth bug/);
  assert.match(text, /task done/);

  const off = await run(['hook', 'subagent-stop'], { env: { ...p.env, WILLS_SUBAGENTS: 'off' }, input: JSON.stringify({ agent_id: 'zzzzzz99', agent_transcript_path: agentTx, cwd: p.root }) });
  assert.strictEqual(off.code, 0);
  assert.strictEqual(willsIn(path.join(p.wills, 'subagents')).length, 1);
});

test('publik engine: the model will replaces the plain one, under the model’s title', async () => {
  const p = project();
  const mock = await mockPublik(() => ({
    status: 200,
    json: { choices: [{ message: { content: 'title: auth redirect loop\n> I fixed the loop. The race outlived me.\n\n## Unfinished business\n- refresh race `src/refresh.ts:88`' } }] },
  }));
  try {
    const env = { ...p.env, WILLS_ENGINE: 'publik', PUBLIK_API_KEY: 'pk_test_mockmockmockmock', PUBLIK_API_BASE_URL: mock.url };
    await run(['hook', 'session-end'], { env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root, reason: 'clear' }) });
    const file = await waitFor(() => willsIn(p.wills).find((f) => f.includes('auth-redirect-loop')));
    assert.ok(file, `model will never arrived: ${willsIn(p.wills)}`);
    assert.strictEqual(willsIn(p.wills).length, 1, 'the plain will must be replaced, not kept beside it');
    const text = fs.readFileSync(path.join(p.wills, file), 'utf8');
    assert.match(text, /written by publik/);
    assert.match(text, /> I fixed the loop/);
    const call = mock.calls[0];
    assert.strictEqual(call.url, '/chat/completions');
    assert.strictEqual(call.body.model, 'publik-fast');
    assert.strictEqual(call.auth, 'Bearer pk_test_mockmockmockmock');
    assert.ok(!JSON.stringify(call.body).includes('sk-ant-api03'), 'secrets must be redacted before they leave');
  } finally {
    mock.close();
  }
});

test('publik 402: the plain will stays, and the next session shows the add-credit link', async () => {
  const p = project();
  const mock = await mockPublik(() => ({ status: 402, json: { error: { message: 'Your publik balance is empty.', top_up_url: 'https://publikhq.com/claim/xyz' } } }));
  try {
    const env = { ...p.env, WILLS_ENGINE: 'publik', PUBLIK_API_KEY: 'pk_test_mockmockmockmock', PUBLIK_API_BASE_URL: mock.url };
    await run(['hook', 'session-end'], { env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root }) });
    const err = await waitFor(() => fs.existsSync(path.join(p.env.AGENT_WILLS_HOME, 'last-error.json')));
    assert.ok(err);
    const files = willsIn(p.wills);
    assert.strictEqual(files.length, 1);
    assert.match(fs.readFileSync(path.join(p.wills, files[0]), 'utf8'), /written by plain/);
    const start = await run(['hook', 'session-start'], { env, input: JSON.stringify({ cwd: p.root, source: 'startup' }) });
    assert.match(JSON.parse(start.out).systemMessage, /publik balance is empty.*https:\/\/publikhq\.com\/claim\/xyz/);
    const doctor = await run(['doctor'], { env, cwd: p.root });
    assert.match(doctor.out, /add credit: https:\/\/publikhq\.com\/claim\/xyz/);
  } finally {
    mock.close();
  }
});

test('a will the agent wrote itself (/will) is never overwritten by the summary', async () => {
  const p = project();
  const self = await run(['self', '--transcript', p.transcript], { env: p.env, cwd: p.root, input: '> I wrote this myself.\n## Last wishes\n- ship it' });
  assert.strictEqual(self.code, 0, self.err);
  const [file] = willsIn(p.wills);
  assert.match(fs.readFileSync(path.join(p.wills, file), 'utf8'), /signed .* written by itself\n> I wrote this myself\./);
  await run(['hook', 'session-end'], { env: p.env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root }) });
  assert.deepStrictEqual(willsIn(p.wills), [file]);
  assert.match(fs.readFileSync(path.join(p.wills, file), 'utf8'), /I wrote this myself/);
});

test('install merges into settings.json without touching other hooks; uninstall removes only ours', async () => {
  const p = project();
  const settings = path.join(p.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const mine = { model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  fs.writeFileSync(settings, JSON.stringify(mine));
  for (let i = 0; i < 2; i++) assert.strictEqual((await run(['install'], { env: p.env, cwd: p.root })).code, 0);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.SessionStart.length, 2, 'installing twice must not double the hooks');
  assert.strictEqual(s.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /\.agent-wills\/app\/bin\/wills\.js" hook session-end$/);
  assert.ok(fs.existsSync(path.join(p.env.AGENT_WILLS_HOME, 'app', 'bin', 'wills.js')), 'hooks must not point into an npx cache');
  assert.ok(fs.existsSync(settings + '.agent-wills.bak'));
  const cmd = fs.readFileSync(path.join(p.home, '.claude', 'commands', 'will.md'), 'utf8');
  assert.ok(!cmd.includes('${CLAUDE_PLUGIN_ROOT}') && cmd.includes('.agent-wills/app/bin/wills.js'));

  assert.strictEqual((await run(['uninstall'], { env: p.env, cwd: p.root })).code, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), mine);
  assert.ok(!fs.existsSync(path.join(p.home, '.claude', 'commands', 'will.md')));
});

test('install refuses to touch a settings.json it cannot parse', async () => {
  const p = project();
  const settings = path.join(p.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ broken');
  const r = await run(['install'], { env: p.env, cwd: p.root });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{ broken');
});

test('the CLI lists, reads, recalls and shows the estate', async () => {
  const p = project();
  await run(['hook', 'session-end'], { env: p.env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root }) });
  const list = await run([], { env: p.env, cwd: p.root });
  assert.match(list.out, /1 will in \.claude\/wills\//);
  assert.match(list.out, /“I fixed the redirect loop/);
  const read = await run(['read', '1'], { env: p.env, cwd: p.root });
  assert.match(read.out, /^# Will of abc123/);
  const recall = await run(['recall', 'redis'], { env: p.env, cwd: p.root });
  assert.match(recall.out, /REDIS_URL/);
  const estate = await run(['estate'], { env: p.env, cwd: p.root });
  assert.match(estate.out, /~\d+ tokens/);
  const none = await run(['read', 'zzz'], { env: p.env, cwd: p.root });
  assert.strictEqual(none.code, 1);
});

test('scripted runs (claude -p, the SDK) leave no will and get no estate unless asked', async () => {
  const p = project();
  const tx = fakeTranscript(tmp('tx-'), { root: p.root, entrypoint: 'sdk-cli' });
  await run(['hook', 'session-end'], { env: p.env, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: tx, cwd: p.root }) });
  assert.strictEqual(willsIn(p.wills).length, 0);
  await run(['hook', 'session-end'], { env: { ...p.env, AGENT_WILLS_HOME: p.env.AGENT_WILLS_HOME }, input: JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root }) });
  assert.strictEqual(willsIn(p.wills).length, 1);
  const sdkStart = await run(['hook', 'session-start'], { env: { ...p.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, input: JSON.stringify({ cwd: p.root, source: 'startup' }) });
  assert.strictEqual(sdkStart.out, '');
  await run(['config', 'scripted', 'true'], { env: p.env, cwd: p.root });
  const allowed = await run(['hook', 'session-start'], { env: { ...p.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, input: JSON.stringify({ cwd: p.root, source: 'startup' }) });
  assert.match(allowed.out, /agent-wills/);
});

test('/will uses the running session id, so two open sessions never swap wills', async () => {
  const p = project();
  const a = await run(['self'], { env: { ...p.env, CLAUDE_CODE_SESSION_ID: '11111111-aaaa' }, cwd: p.root, input: '> I am session one.' });
  const b = await run(['self'], { env: { ...p.env, CLAUDE_CODE_SESSION_ID: '22222222-bbbb' }, cwd: path.join(p.root), input: '> I am session two.' });
  assert.strictEqual(a.code + b.code, 0, a.err + b.err);
  const files = willsIn(p.wills);
  assert.strictEqual(files.length, 2, files.join(', '));
  assert.ok(files.some((f) => f.endsWith('-11111111aa.will.md')) && files.some((f) => f.endsWith('-22222222bb.will.md')));
});

test('install follows a symlinked settings.json, keeps its mode, and never takes over someone else\'s will.md', async () => {
  const p = project();
  const real = path.join(p.home, 'dotfiles', 'claude-settings.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"model":"opus"}', { mode: 0o600 });
  fs.mkdirSync(path.join(p.home, '.claude', 'commands'), { recursive: true });
  fs.symlinkSync(real, path.join(p.home, '.claude', 'settings.json'));
  fs.writeFileSync(path.join(p.home, '.claude', 'commands', 'will.md'), 'my own will command');
  assert.strictEqual((await run(['install'], { env: p.env, cwd: p.root })).code, 0);
  assert.ok(fs.lstatSync(path.join(p.home, '.claude', 'settings.json')).isSymbolicLink(), 'symlink kept');
  assert.match(fs.readFileSync(real, 'utf8'), /agent-wills/);
  assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(path.join(p.home, '.claude', 'commands', 'will.md'), 'utf8'), 'my own will command');
  await run(['uninstall'], { env: p.env, cwd: p.root });
  assert.strictEqual(fs.readFileSync(path.join(p.home, '.claude', 'commands', 'will.md'), 'utf8'), 'my own will command');
});

test('install --project writes settings.local.json, never the shared settings.json', async () => {
  const p = project();
  assert.strictEqual((await run(['install', '--project'], { env: p.env, cwd: p.root })).code, 0);
  assert.ok(fs.existsSync(path.join(p.root, '.claude', 'settings.local.json')));
  assert.ok(!fs.existsSync(path.join(p.root, '.claude', 'settings.json')));
});

test('two background rewrites of one session leave exactly one will', async () => {
  const p = project();
  let n = 0;
  const mock = await mockPublik(() => ({ status: 200, json: { choices: [{ message: { content: `title: take ${++n}\n> attempt ${n}.` } }] } }));
  try {
    const env = { ...p.env, WILLS_ENGINE: 'publik', PUBLIK_API_KEY: 'pk_test_mockmockmockmock', PUBLIK_API_BASE_URL: mock.url };
    const input = JSON.stringify({ session_id: 'abc123def456', transcript_path: p.transcript, cwd: p.root });
    await Promise.all([run(['hook', 'session-end'], { env, input }), run(['hook', 'session-end'], { env, input })]);
    await waitFor(() => mock.calls.length >= 2 && willsIn(p.wills).length === 1 && willsIn(p.wills)[0].includes('take-2'), 10000);
    assert.deepStrictEqual(willsIn(p.wills).length, 1, willsIn(p.wills).join(', '));
  } finally {
    mock.close();
  }
});
