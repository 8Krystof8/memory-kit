# Codex

Codex (the CLI, the IDE extension and Codex cloud) reads `AGENTS.md` by itself. It searches with
`rg` and reads files in parallel batches, which is the pattern the kit's search rules are written
for.

## What Codex picks up

| file | how |
|---|---|
| `AGENTS.md` | loaded automatically. Codex reads the chain of `AGENTS.md` files from the repository root down to the working directory, with a size cap (32 KiB by default). The kit's file stays under 8,000 characters. |
| `.agents/skills/memory/SKILL.md` | a skill in the open Agent Skills format. According to the Codex documentation, repository skills are read from `.agents/skills/`; the kit has not tested this. |
| `.githooks/pre-commit` | runs on every commit once `core.hooksPath` is set (`init` and `start` set it) |
| `.codex/hooks.json` | optional: a SessionStart hook that loads the start file (below). The kit does not ship it. |

## Setup

Nothing to do. The first lines of `AGENTS.md` (its system section) say: if "Memory: start" is not in
your context yet, run `node system/memory.mjs start` first. Codex reads `AGENTS.md`, runs the
command and then knows the sectors, the hot notes and the `## Now` section. The condition keeps an
agent whose hook already printed the start file from loading it twice.

When the memory is not the repository you work in, clone it next to the project and tell Codex
where it is, for example in the project's `AGENTS.md`:

```markdown
- Long-term memory lives in ../my-memory. Start with `node ../my-memory/system/memory.mjs start`;
  run rg commands from that folder.
```

The script finds its vault from its own location, so it works from any working directory.

## Optional: load the start file with a hook

Codex runs hooks when a session starts, resumes, is cleared or is compacted. A SessionStart hook
puts the start file into Codex's context before the first message, so the agent does not have to
run `start` itself. Create `.codex/hooks.json` in the vault:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node system/memory.mjs start",
            "statusMessage": "Loading the memory",
            "additionalContextLimit": 5000
          }
        ]
      }
    ]
  }
}
```

- Codex adds the plain text the command prints to its context. The start output is at most 9,500
  bytes: about 3,500 tokens in English, more in Czech. `additionalContextLimit` (in tokens) keeps it
  whole: with the default limit of about 2,500 tokens, Codex would save the output to a file and
  show the model only a preview.
- The command runs in the folder where the session started, so start Codex in the vault's root
  folder.
- Codex loads a project's hooks only when you trust the project, and it asks you to review every new
  or changed hook. Open `/hooks` in Codex, look at the command and trust it.
- On Windows, if accented letters arrive garbled, add
  `"commandWindows": "node system/memory.mjs start --format gemini-hook"` next to `command`. That
  format prints the same text as one line of JSON (`hookSpecificOutput.additionalContext`), which
  Codex also accepts, with every non-ASCII character escaped, so no console code page can change it.

To load the memory in every project, put the same hook into `~/.codex/hooks.json` and write the
vault's absolute path in the command, for example
`node /Users/you/my-memory/system/memory.mjs start` (on Windows with forward slashes, such as
`node C:/Users/you/my-memory/system/memory.mjs start`).

`start --format` has three values: `text` (the default, for Codex and Claude Code), `gemini-hook`
(one line of JSON for hooks that read `hookSpecificOutput`) and `json` (`{text, stale, initialized,
failed}` for programs).

## Codex cloud

- The environment needs Node 22 or newer. The kit has no dependencies, so it needs no setup script
  and no network access.
- Each task gets a fresh checkout. The committed `_ai/` files and `start`'s rendering of a fresh
  view on the fly cover that.
- Cloud tasks usually end in a pull request. Merge memory pull requests soon: phones and other
  agents read the default branch.

## Working well with Codex

- Codex truncates the middle of very long tool outputs. The kit's outputs are compact on purpose:
  search results take one line each, and the start file is at most 8,500 bytes. Never `cat` the
  catalog: grep it.
- Approve `node system/memory.mjs …` and the git commands when Codex asks, or allow them in your
  approval settings.
- Codex has no subagents like Claude Code's `memory-searcher`. For broad questions, it follows the
  same limits by itself: at most three searches with different stems, headers first, at most two
  whole files.
- Codex's own memories feature is not the source of truth. "Remember this" means a note in the
  repository, written by the rules in `AGENTS.md`.
- On Windows, Codex may run commands in Windows PowerShell 5.1, which rejects `&&`. The kit prints
  every command on its own line for this reason; run them one at a time.

## MCP: the memory in every project

Inside the vault the CLI is all Codex needs. To reach the memory from other projects too, add its
MCP server once:

```sh
node system/memory.mjs connect codex
```

It appends a `[mcp_servers.memory-kit]` table to `~/.codex/config.toml` (`CODEX_HOME` is respected)
and leaves every other byte of the file as it was. Restart Codex (the command, the IDE extension
or the ChatGPT desktop app, which share this file); `codex mcp list` or `/mcp` shows the server.
The tools are `memory_start`, `memory_search`, `memory_read`, `memory_recent` and `memory_inbox`
(left out with `--read-only`). `connect codex --remove` takes the table out again. More in
[mcp.md](mcp.md).
