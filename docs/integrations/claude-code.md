# Claude Code

Claude Code gets the most complete integration: rules through `CLAUDE.md`, a SessionStart hook that
loads the start file, a subagent for broad questions, and the pre-commit check through git.

## What the kit ships

| file | what it does |
|---|---|
| `CLAUDE.md` | `@AGENTS.md` (imports the shared rules) plus two lines only for Claude Code |
| `.claude/settings.json` | a SessionStart hook with matcher `startup\|resume\|clear\|compact` and the command `node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start` (see below why it has this form) |
| `.claude/agents/memory-searcher.md` | a subagent for broad questions: tools Read, Grep, Glob and Bash; returns at most 1,500 tokens with `path:line` citations |
| `.agents/skills/memory/SKILL.md` | a skill in the open Agent Skills format: run `start`, follow "How to search", read `AGENTS.md` before writing |
| `.claude/skills/memory/SKILL.md` | the same skill, byte for byte, where Claude Code looks for project skills (a test keeps the two copies equal) |
| `.githooks/pre-commit` | `check --generate --strict`; `start` sets `core.hooksPath` so it runs |

The hook is a shell command with the placeholder in braces and the path in double quotes:

```json
"command": "node \"${CLAUDE_PROJECT_DIR}/system/memory.mjs\" start"
```

It runs on every Claude Code version under sh, bash and Git Bash, also with spaces in the path,
and under PowerShell from Claude Code 2.1.198 on, which rewrites the braced placeholder for
PowerShell. The kit does not use the exec form (`"command": "node"` with `"args"`): Claude Code
before 2.1.139 ignores `args`, and the hook then fails. The hook of 0.1.0 wrote
`$CLAUDE_PROJECT_DIR` without braces, which only a POSIX shell expands; `upgrade` replaces it with
this one unless you changed the file.

Claude Code reads `AGENTS.md` by itself only when there is no `CLAUDE.md`. The recommended pattern
is a `CLAUDE.md` that imports it, which is what the kit ships. Keep `CLAUDE.md` short (≤ 25 lines,
40 at most): an inflated rules file leads to ignored instructions. Notes for humans go into HTML
comments, which Claude Code strips before they reach the context.

## Case 1: the session runs in the memory repository

This works on the web and locally, and needs no setup. At startup, on resume, after `/clear` and
after compaction, the hook prints the start file. Its output is at most 9,500 bytes, because Claude Code shows hook
output over 10,000 characters only as a short preview. The search rules are in context from the first message on. `AGENTS.md` is
imported through `CLAUDE.md`.

If you do not see the start file, run `node system/memory.mjs start` yourself, or ask Claude to.

## Case 2: you work in another project, memory is a second folder

Most of the time you work in a code repository, and the memory is a separate one. The examples
keep it in `~/my-memory`, where `~` is your home folder. `cd ~/my-memory` works in bash, zsh and
PowerShell. A `~` handed to a program, as in `claude --add-dir ~/my-memory`, is expanded only by
bash and zsh: PowerShell on Windows before 7.6 (the built-in Windows PowerShell 5.1 too) and cmd
pass it on unchanged, so in those shells write the full path, such as `C:/Users/you/my-memory`.

**Locally:**

1. Clone the memory next to your projects, for example to `~/my-memory`.
2. Start Claude Code with the extra directory: `claude --add-dir ~/my-memory`. To also load the
   memory's `CLAUDE.md` (and with it `AGENTS.md`), set
   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
3. Add a SessionStart hook to the project's `.claude/settings.json`, or to `~/.claude/settings.json`
   for every project. Write the memory's absolute path in double quotes (`~` and `$HOME` are not
   expanded in every shell Claude Code may use; on Windows write the path with forward slashes,
   such as `C:/Users/you/my-memory/system/memory.mjs`):

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup|resume|clear|compact",
           "hooks": [
             {
               "type": "command",
               "command": "node \"/Users/you/my-memory/system/memory.mjs\" start"
             }
           ]
         }
       ]
     }
   }
   ```

   If the memory is not at that path, the hook fails with node's "Cannot find module" message in
   the session: clone it there, or fix the path.

4. Tell Claude where the memory lives. One line in the project's `CLAUDE.md` is enough:
   `Memory: ~/my-memory. Run its commands and rg paths from that folder.`

**Or through MCP, in every project at once:** run these in the memory folder, one at a time:

```sh
cd ~/my-memory
node system/memory.mjs connect claude-code
```

`connect` registers the memory's MCP server in your user scope (through
`claude mcp add --scope user`, or by editing `~/.claude.json` when the `claude` command is not
found). Every new session in any project then has the tools `memory_start`, `memory_search`,
`memory_read`, `memory_recent` and `memory_inbox`; ask Claude to call `memory_start` first. Check
with `claude mcp get memory-kit` or `/mcp`. Details in [mcp.md](mcp.md).

With the memory's full path, `node /Users/you/my-memory/system/memory.mjs …` (on Windows
`node C:/Users/you/my-memory/system/memory.mjs …`) works from any working directory, because the
script finds its vault from its own location, never from the current directory. The `rg` commands
in the search rules use paths relative to the memory root (`_ai/catalog.tsv`, `sectors/`), so run
them there or prefix the paths.

For the subagent, copy `.claude/agents/memory-searcher.md` to the project's `.claude/agents/` or to
`~/.claude/agents/`, and put the memory's absolute path into its prompt.

**On the web:** add the memory repository to the session next to your project (through the
repository picker, or ask Claude to add it). Hooks in a repository's `.claude/settings.json` may not
run in sessions with several repositories. The skill below is the fallback.

## A skill for sessions that start elsewhere

A skill that only connects the memory rarely needs to change, because the start file carries the
protocol. Adapt the kit's `.agents/skills/memory/SKILL.md` to the path your sessions use, for
example:

```markdown
---
name: memory-start
description: Connects my long-term memory (a private git repository of markdown notes). Use at the start of every session and whenever I say "what did we decide", "search memory", "remember this", "how did we do", "do you know about".
---
1. If ~/my-memory does not exist, get the memory repository into the session (add it, or clone it there).
2. In ~/my-memory, run `node system/memory.mjs start` and follow its output, above all "How to search".
3. Before the first write, read ~/my-memory/AGENTS.md.
```

Put it in `~/.claude/skills/memory-start/SKILL.md` for local sessions. For cloud sessions, upload
it as a zip in the claude.ai settings (Capabilities → Skills). Skills enabled there are available in
Claude Code on the web too. A skill that was used comes back into context after compaction, so step
2 runs again.

Claude Code looks for project skills in `.claude/skills/`, so the kit ships the skill there as well
as in `.agents/skills/` (for Codex and other agents that read the open format). The two files are
identical. If your Claude Code version also reads `.agents/skills/` and lists the skill twice, delete
`.claude/skills/memory/`.

## Broad questions: the memory-searcher subagent

"What do we know about X" or "how did we handle Y" would pull many files into the main context. The
rules send such questions to `memory-searcher`. It runs at most three searches with different stems,
reads the headers of at most six files and at most two whole files, never writes, and returns the
answer, `path:line — quote` evidence and what stayed uncertain. The built-in Explore subagent is
not used, because it skips `CLAUDE.md` and does not know the search rules.

The subagent's `tools` field lists the full Bash tool, and its prompt limits Bash to
`node system/memory.mjs search` and `rg`. Restricting Bash to one command inside the `tools` field
is not documented, so the kit does not rely on it.

## Writing and committing

- Claude writes through `node system/memory.mjs new <type> <sector>/<name>` after
  `search --duplicates`, and follows the Writing section of `AGENTS.md`.
- Every commit runs the pre-commit hook: the strict check, and regeneration of `_ai/` and
  `.ignore`, which are added to the commit.
- `node system/memory.mjs sync` pushes with `pull --rebase` and never forces.
- Claude Code on the web often works on a branch and opens a pull request. Merge memory branches
  soon: phones sync the default branch, and so do sessions in other projects.
- To stop permission prompts for the memory commands, allow them in `/permissions`, for example
  with the rule `Bash(node system/memory.mjs:*)`.

## Claude Code's own memory

Claude Code's auto memory is tied to one machine and does not travel to cloud sessions. For
anything that should last, "remember this" means a note in this repository. If Claude reaches for
its own memory instead, add a line to the `## Personal rules` section of `AGENTS.md`:
`"Remember" always means writing to this repository.`

## Troubleshooting

| symptom | fix |
|---|---|
| no start file at the beginning of a session | the hook did not run (a multi-repository session, or the hook is not in this project); run `node system/memory.mjs start` or use the skill |
| the start file is shown only as a short preview | its output exceeded the hook limit; run `check` and look for `START_BUDGET` or `GEN_BUDGET` |
| commits are not checked | `git config core.hooksPath .githooks`, or run `start` once; `node system/memory.mjs doctor` shows the cause |
| the hook fails on Windows with a path error | the hook of 0.1.0 writes `$CLAUDE_PROJECT_DIR` without braces, which PowerShell cannot expand (Claude Code uses PowerShell when Git Bash is missing). Use the kit's current hook, `node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start`, with Claude Code 2.1.198 or newer, or install Git for Windows (`doctor` reports it under `adapters`) |
| the hook fails with `SyntaxError: Unexpected token ':'` from `[stdin]` | the hook is in exec form (`"args"`), and Claude Code before 2.1.139 ignores `args`, so node reads the hook's input as a script. Update Claude Code, or use the shell form above |
| Claude greps `archive/` and finds nothing | `.ignore` hides it on purpose; use `search --all` or an explicit path |
| node reports "Cannot find module" with a `~` folder in the path | the shell passed `~` on unchanged (PowerShell on Windows before 7.6, cmd); run the command in the memory folder, or write the full path |
