# Gemini CLI

Gemini CLI loads `GEMINI.md` files as context. The kit's `GEMINI.md` is a single line:

```markdown
@AGENTS.md
```

Gemini CLI resolves `@file` imports, so it gets exactly the same rules as every other agent. `check`
verifies that the import is the first non-empty line (`ADAPTER_IMPORT`).

Do not also set `context.fileName` to `AGENTS.md` in `.gemini/settings.json`. Gemini would then
load the rules twice.

## Setup

Nothing to do. The system section of `AGENTS.md` (imported by `GEMINI.md`) tells Gemini to run
`node system/memory.mjs start` first when "Memory: start" is not in its context yet. Gemini runs
it through its shell tool. Approve `node system/memory.mjs …` when asked.

If your Gemini CLI version supports Agent Skills from `.agents/skills/`, it also finds the kit's
`memory` skill. `GEMINI.md` alone is enough.

## Optional: load the start file with a hook

Gemini CLI can put the start file into its context by itself when a session starts, resumes or is
cleared, so the agent does not have to run `start` first. Add a SessionStart hook to
`.gemini/settings.json` in the vault:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "name": "memory-start",
            "type": "command",
            "command": "node system/memory.mjs start --format gemini-hook"
          }
        ]
      }
    ]
  }
}
```

- **Use `--format gemini-hook`, not plain `start`.** Gemini CLI gives the model only the
  `additionalContext` of a JSON answer. Plain text from a hook is shown to you as a message, and the
  model never sees it. `start --format gemini-hook` prints exactly one line of JSON:
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. Every
  non-ASCII character is escaped (`\u00e1` for `á`), so the text arrives intact in any console code
  page.
- **Start `gemini` in the vault's root folder.** The hook runs with the session's folder as its
  working directory, through `bash` on macOS and Linux and PowerShell on Windows. The command above
  works in all of them.
- **No `matcher` is needed.** Without one the hook runs for every source: startup, resume and
  `/clear`.
- **Trust.** Gemini CLI asks you to trust a project's hooks the first time, and again whenever
  their command changes.

To load the memory in every project, put the same hook into `~/.gemini/settings.json` and write
the vault's absolute path in the command, for example
`node /Users/you/my-memory/system/memory.mjs start --format gemini-hook` (on Windows with forward
slashes, such as `node C:/Users/you/my-memory/system/memory.mjs start --format gemini-hook`). Do not
build the path from `$GEMINI_PROJECT_DIR`: Gemini CLI inserts that value in quotes, and the quoting
differs between bash and PowerShell.

`start --format` has three values: `text` (the default), `gemini-hook` (this hook) and `json`
(`{text, stale, initialized, failed}` for programs).

## MCP: the memory in every project

`node system/memory.mjs connect gemini-cli` adds the memory's MCP server to
`~/.gemini/settings.json` (`GEMINI_CLI_HOME` is respected), so Gemini can call `memory_search`,
`memory_read` and the other tools from any folder. Then start `gemini` again (or run
`/mcp reload`) and trust the folder when asked: in untrusted folders Gemini CLI starts no MCP
servers. `/mcp list` shows the server as connected.

If the settings file contains comments, `connect` leaves it alone and prints the entry to paste
into `"mcpServers"`. More in [mcp.md](mcp.md).

## Things to know

- **Its own search tools may not read `.ignore`.** Gemini's grep and glob tools respect
  `.gitignore` and `.geminiignore`. Depending on the version and settings, they may ignore
  ripgrep's `.ignore`, and then archived notes and sleeping sectors appear in their results. Rule 6
  of the search protocol still applies: status `active` and the newer `updated` win, and
  `replaced_by` leads to the valid version. Prefer `node system/memory.mjs search`, which ranks and
  filters. Adding `archive/` to a `.geminiignore` would hide the archive from all of Gemini's file
  tools, so the kit does not do it.
- **`save_memory` is not the memory.** Gemini CLI's memory tool appends facts to a global
  `GEMINI.md` in your home folder, which travels nowhere. For anything that should last, "remember
  this" means a note in this repository. If Gemini reaches for `save_memory`, add a personal rule:
  `"Remember" always means writing to this repository, never save_memory.`
- **Broad questions:** there is no subagent. Gemini follows the limits of the protocol itself: at
  most three searches with different stems, headers first, at most two whole files.
- **Commits** go through the pre-commit hook like everyone else's.

## Gemini in the browser or the app

The Gemini app cannot read your files and has no memory API. Paste `_ai/profile.md` into its
personal instructions ("Instructions for Gemini"), and read [chatgpt.md](chatgpt.md) for the
limits of that approach. It works the same way.
