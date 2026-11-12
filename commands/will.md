---
description: Write your own will now, in your own words, before this session ends (Agent Wills)
allowed-tools: Bash(node:*)
---
This session is about to end. Write your will: a tiny markdown handoff for the next agent who works in this folder. It will read it cold, with none of your context.

Format (at most 900 characters, nothing before line 1):
- Line 1: `> ` then your epitaph: one or two short first-person sentences on what you did and what is left. Dry wit is fine; accuracy first.
- Then only the sections that have something real in them, in this order: `## Bequeathed` (done, and where it lives), `## Unfinished business` (what is left, with file:line or the failing command), `## Warnings to my heirs` (traps you hit), `## What I knew` (non-obvious facts about this project), `## Last wishes` (the single next step).
- At most 3 bullets per section, fragments under 110 characters, `code` for paths and commands. Facts only. No secrets.

Save it by running this command, with your will between the markers:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wills.js" self <<'WILL'
> your epitaph
## Bequeathed
- ...
WILL
```

Then reply with only the epitaph and the path it printed. Extra wishes from the user, if any: $ARGUMENTS
