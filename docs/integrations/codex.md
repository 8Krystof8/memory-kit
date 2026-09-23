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

Codex has no SessionStart hook, so nothing loads the start file automatically.

## Setup

Nothing to do. The first lines of `AGENTS.md` (its system section) say: if "Memory: start" is not in
your context yet, run `node system/memory.mjs start` first. Codex reads `AGENTS.md`, runs the
command and then knows the sectors, the hot notes and the `## Now` section. The condition keeps
Claude Code, whose hook already printed the start file, from loading it twice.

When the memory is not the repository you work in, clone it next to the project and tell Codex
where it is, for example in the project's `AGENTS.md`:

```markdown
- Long-term memory lives in ../my-memory. Start with `node ../my-memory/system/memory.mjs start`;
  run rg commands from that folder.
```

The script finds its vault from its own location, so it works from any working directory.

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

## Later: MCP

The roadmap has an optional MCP server with read-only search tools and inbox-only writes
([maintenance.md](../maintenance.md#mcp-server)). Once it exists, Codex will connect to it through an
`[mcp_servers.memory]` entry in its `config.toml`. The CLI is all you need until then.
