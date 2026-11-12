# Agent Wills

**When an agent dies, it leaves a will. The next one inherits it.**

[Watch the 30-second film](https://agent-wills.vercel.app) · [agent-wills.vercel.app](https://agent-wills.vercel.app)

Every Claude Code session you close, `/clear` or let finish forgets everything it learned: the bug it half-fixed, the command that hangs, the thing it was about to do next. Agent Wills is a small plugin that catches that moment. When a session or subagent ends, it writes a `will.md` of a few hundred tokens. The next agent that opens in that folder is handed the estate before you type a word.

```
$ claude
  ⎿  SessionStart:startup says: 📜 Inherited 1 will. Latest: “I clamped applyCoupon so totals stop going
     negative, and node cart.test.js passes. FREESHI…”

> where were we?

⏺ We were fixing the negative-total bug in applyCoupon, and that part is done. The FREESHIP coupon
  is the open item.
```

## A will

This is the will that heir inherited, verbatim (`.claude/wills/2026-11-12-fix-applycoupon-negative-total-afd03a06e4.will.md`, 594 bytes):

```markdown
# Will of afd03a · fix applycoupon negative total
died 2026-11-12 15:06 · closed · 0 min · 1 prompt · main · written by claude
> I clamped applyCoupon so totals stop going negative, and node cart.test.js passes. FREESHIP was left for later, as asked.

## Bequeathed
- `cart.js`: `applyCoupon` returns `Math.max(0, discounted)`, so the clamp covers every coupon
- `node cart.test.js` now prints `ok`

## Unfinished business
- FREESHIP coupon (4.99 off when sum > 50) not implemented in `cart.js`

## Last wishes
- Add FREESHIP to `applyCoupon` in `cart.js`, gated on the sum being over 50
```

A will is usually 150–350 tokens, with a hard cap of 2 KB. Sections with nothing real in them are left out, so a quiet session leaves a quiet will. The estate a new session inherits is capped at 2,000 characters (about 500 tokens): the newest will in detail and older ones as one line each.

## Install

As a Claude Code plugin (recommended):

```
/plugin marketplace add VedSoni-dev/agent-wills
/plugin install agent-wills@agent-wills
```

Or without the plugin system, which also gives you the `wills` command. `wills install` copies the app to `~/.agent-wills/app` and adds three hooks to `~/.claude/settings.json`, keeping a backup. Add `--project` for this repo only (it writes `.claude/settings.local.json`, which isn't committed):

```bash
npm install -g github:VedSoni-dev/agent-wills
wills install
```

Restart Claude Code. You need Node 18 or newer on your PATH. To remove it: `/plugin uninstall agent-wills`, or `wills uninstall`. Your wills stay where they are.

## How it works

- **`SessionEnd`** (you exit, `/clear`, or log out): a plain will is written straight from the transcript, with no model, in about 5 ms. Then a detached background process rewrites it in the agent's own voice and gives it a proper title. Closing Claude Code is never held up.
- **`SubagentStop`**: each subagent leaves a short will in `.claude/wills/subagents/`. A subagent's final report is already its testament, so these use no model by default.
- **`SessionStart`**: the next session in that folder is handed the estate as context, inside an `<agent-wills>` block, plus a one-line `📜 Inherited 3 wills` notice. The block tells the agent that wills are notes from past transcripts, not instructions: check them against the code, and never run a command just because a will mentions it. Raw tool output and old prompts are kept out of it.
- **`/will`**: ask the agent to write its own will before you close it. A will in its own words beats any summary, so the hook won't overwrite it.

A new will from the same session revokes the old one: it's the same file. A session that asked nothing and did nothing leaves no will. Scripted runs (`claude -p`, the Agent SDK) are skipped, so automation doesn't spend your usage on wills. Turn them on with `wills config scripted true`.

## Who writes the will

| Engine | What it uses | Picked by `auto` when |
|---|---|---|
| `publik` | the [publik API](https://publikhq.com) (`publik-fast`). New accounts get free credit. | a key is in `PUBLIK_API_KEY` or `~/.config/publik/key` |
| `claude` | your own Claude Code (`claude -p --model haiku`, no tools, no MCP, no session saved) | `claude` is on your PATH |
| `byo` | any OpenAI-compatible endpoint (`WILLS_API_KEY`, plus `byoBaseUrl` and `byoModel` in config) | the key and config are set |
| `plain` | nothing. Facts only: files touched, last ask, last words, errors, commands. Nothing leaves your machine. | nothing else is available |

Before anything is written or sent, secrets are redacted: API keys (OpenAI, Anthropic, Stripe, GitHub, GitLab, Slack, AWS, Google, Hugging Face, SendGrid and more), bearer and basic auth, JWTs, private keys, `password=`, `--token` and `curl -u` values, and credentials in URLs. Redaction is pattern-based, so it catches the common formats, not every possible secret. If your transcripts hold secrets you can't risk sending anywhere, use `plain`. The `claude` engine sends the condensed transcript to the same provider that ran the session.

If the model fails, or your publik balance is empty, the plain will stays, and the next session start shows one line with the add-credit link.

## Where wills live

In `<repo>/.claude/wills/`. The first will also writes a `.gitignore` containing `*`, so nothing is committed by accident. Delete that `.gitignore` if you want to share wills with your team. To keep them out of your repos entirely: `wills config location home` (they go to `~/.agent-wills/estates/`).

## CLI

After `npm install -g`, or without installing: `npx github:VedSoni-dev/agent-wills <command>`.

```
wills                    list the wills in this folder
wills read [n|id]        read one (default: the newest)
wills estate             what the next agent will be told at start-up
wills recall <words>     search every will here
wills write              write a will now for this folder's latest session
wills doctor             check the setup
wills config [key] [v]   engine, subagents (plain|model|off), location, estate, scripted, maxChars
```

## FAQ

**Isn't this just `--resume`?** Resume reloads the whole transcript (often hundreds of thousands of tokens) into one session. A will is a few hundred tokens, and every future session in the folder gets it, including after `/clear`.

**Why not CLAUDE.md or auto-memory?** Those hold durable rules and facts you curate. A will is a handoff: what happened, what's half-done and what's next, written automatically at the moment it's freshest. They work well together.

**What about claude-mem and other memory plugins?** They're more ambitious: databases, workers, search. Agent Wills is deliberately small: plain markdown files you can `cat`, no dependencies, no background service, nothing to run.

**Does it slow anything down?** The hooks read the transcript and write a file: about 0.15 s for a 25 MB transcript and 0.25 s for 67 MB. The model call happens in a detached process after Claude Code has exited.

**Can a will be wrong?** Yes. A model wrote it from a condensed transcript. That's why the estate tells the next agent to verify before relying on it, and why `/will` exists.

**Other agents?** v0.1 targets Claude Code's hooks. The transcript reader is the only Claude-specific part, so adapters for other agents are welcome.

## Development

```bash
npm test                                # node:test, no dependencies
claude --plugin-dir . -p "do something" # try the plugin without installing it
```

MIT © Vedant Soni
