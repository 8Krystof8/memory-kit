# Memory for your code projects

One command, and every repository you open in Claude Code (terminal, VS Code, JetBrains) or Codex
gets its own memory. The memory lives in your vault, never in the code repository: nothing to
commit, nothing to `.gitignore`, and clients' repositories stay clean.

```sh
node system/memory.mjs connect claude-code --projects   # or: connect codex --projects
```

Then open a new session in any project. Works the same on Windows, macOS and Linux, also with
spaces and accents in the path of the vault.

## What happens by itself

| when | what the memory does |
|---|---|
| first session in a repository | creates a `dev` sector for it (the next projects get `dev-<name>`) with an overview filled in from `package.json`, the README and the languages it finds |
| every session start | shows the agent the branch, uncommitted files, last commits, the handoff, conventions, gotchas and dead ends of *this* project, plus the usual start view |
| the agent finishes and the code changed | asks it once per session to rewrite the handoff and record fixed errors, dead ends and decisions (no extra model call: the agent is running anyway) |
| a command fails (Claude Code) | looks the error up in the project's gotchas and dead ends and hands a match to the agent |
| the session ends | commits and pushes the vault in the background, when the vault has a remote |

The repository is recognised by its `origin` remote (`github.com/owner/repo`, the same for https
and ssh clones), so a second clone or another computer finds the same sector. Without a remote the
folder name is used.

## The dev sector

| note | what it holds |
|---|---|
| overview | what the project is, stack, how to run it |
| handoff | done, next steps, open questions: rewritten at the end of a session |
| runbook | commands that work (dev, test, build, deploy) |
| conventions | do and do not |
| gotchas | symptom → cause → fix of errors met before |
| dead ends | what was tried and did not work, so nobody tries it again |
| map | where things are in the code |
| log | decisions and facts with dates |

In Czech the notes are named `prehled`, `predavka`, `prikazy`, `konvence`, `pasti`,
`slepe-ulicky`, `mapa` and `zapisnik`.

## Recording by hand

```sh
node /path/to/vault/system/memory.mjs remember --type gotcha "vite: ENOSPC → inotify limit → raise max_user_watches"
```

Run it inside the code repository and it finds the project. Types: `gotcha`, `dead-end`, `todo`,
`run`, `convention`, `decision`, `fact` (default). Outside a project the text goes to `inbox/`.
Text with a secret in it is refused.

## Settings

`connect claude-code --projects` (or `connect codex --projects`) writes the hooks into
`~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`) or `~/.codex/hooks.json` (`$CODEX_HOME`) and a
`projects` block into `memory.json`. The hooks run in every repository you open, work and client
ones too, so by default nothing is added to the memory or pushed by itself:

| key | default | flags | meaning |
|---|---|---|---|
| `enabled` | true | `--remove` sets it to false | the hooks do nothing while it is false |
| `auto_add` | false | `--auto-add`, `--no-auto-add` | give a new repository its memory on its first session |
| `store` | local | `--store local`, `--store git` | local: the dev notes stay in the local root on this computer; git: they go into the vault repository |
| `autosync` | false | `--autosync`, `--no-autosync` | commit and push the vault when a session ends (refused without a git remote or in mode local) |
| `checkpoint` | true | | the end-of-session request for the handoff |
| `error_lookup` | true | | look failed commands up in gotchas and dead ends |

Running `connect … --projects` again without a flag keeps the earlier choices. It prints the
settings file, the events, the hook command, the Claude Code or Codex versions it found and every
setting, marked `(default)` where it is one. `--dry-run` shows all of it without writing, and
`--json` prints it for scripts.

The hook is one shell command, `"<node>" "<vault>/system/memory.mjs" hook claude-code <event>`
(with forward slashes on Windows), which every Claude Code version runs, in `/bin/sh`, Git Bash or
PowerShell, and Codex in your shell or in `cmd.exe`. `<node>` is the full path of the Node.js that
ran `connect` (on Windows without spaces, or its short 8.3 name), so a repository that pins an
older Node.js (nvm, fnm, volta, mise, asdf) does not break the hooks; connect again after
removing that Node.js (`doctor` tells you). Should a hook still start a Node.js older than 22, it
does nothing, exits cleanly and leaves the reason in the hook log, which `doctor` lists. A vault
path that contains `"`, `$`, a backtick, `%` or `!` (on Windows also `„`, `“` or `”`, which
PowerShell reads as quotes) is refused, unless every Claude Code found on the computer is 2.1.139
or newer: then the hooks use the exec form, which needs no shell (`--form exec` asks for it). The
error lookup after a failed command (the PostToolUseFailure event) is installed only when every
Claude Code found is 2.1.101 or newer, because older versions ignore the whole settings file for
an event they do not know. Connect again after updating Claude Code to add it. The SessionEnd hook
is installed only with `--autosync`, its only work, so no exit waits for it otherwise. Codex runs
a new or changed hook only after you trust it in `/hooks`.

`connect claude-code --projects --remove` takes the hooks out again, sets `enabled` to false and
keeps everything else in `~/.claude/settings.json` (a backup goes to
`.memory-kit/backups/connect/`). A settings file with comments is never rewritten: the command
prints the hooks to paste instead. `node system/memory.mjs doctor` checks the hooks (line
`projects.hooks`), and `doctor --probe` also runs the session start hook once, the way the agent
does, in an empty temporary folder, marked as a probe so that it never counts as a session.

Claude Code on the web does not read your user settings; there the vault's own `CLAUDE.md` and
`AGENTS.md` still work.
