# Cursor

Cursor's agent reads `AGENTS.md` from the project root as rules, and according to its documentation
also nested `AGENTS.md` files. It can run terminal commands, so it uses the CLI like any other
agent.

## Setup

1. Open the memory repository as a Cursor project, or add it as a folder of a multi-root workspace
   next to your code.
2. Nothing to add: the system section of `AGENTS.md` tells the agent to run
   `node system/memory.mjs start` first when "Memory: start" is not in its context yet.
3. When the agent asks to run `node system/memory.mjs …`, allow it. You can put the command on the
   allow list in Cursor's agent settings to skip the prompt.

You do not need `.cursor/rules`: one rules file (`AGENTS.md`) serves every agent. If your Cursor
version supports Agent Skills from `.agents/skills/`, it also finds the kit's `memory` skill.

## Things to know

- **Cursor's semantic index is its own.** It indexes the notes like code and can help Cursor find
  things, but other agents and cloud sessions do not share it. The memory's own search
  (`node system/memory.mjs search`) works the same everywhere and understands the language pack
  (stemming, accents), so the rules prefer it.
- **Archived and sleeping content.** ripgrep's `.ignore` hides `archive/` and sleeping sectors from
  grep. Cursor's index and search may still show them. Check the path and the status: only
  `active` notes with the newer `updated` are valid.
- **Background agents** run in cloud machines. They need Node 22 or newer in their environment, and
  their changes arrive as a branch or pull request. Merge memory changes soon.
- **Commits** from Cursor go through the pre-commit hook: the strict check, and regeneration of
  `_ai/`.
- **Broad questions:** there is no `memory-searcher` subagent. The agent follows the protocol's
  limits itself: at most three searches, headers first, at most two whole files.

## Later: MCP

When the roadmap MCP server exists ([maintenance.md](../maintenance.md#mcp-server)), Cursor will
connect to it through `.cursor/mcp.json`. Until then the CLI covers everything.
