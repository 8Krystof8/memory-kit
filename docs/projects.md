# Memory for your code projects

One command, and every repository you open in Claude Code (terminal, VS Code, JetBrains) or Codex
gets its own memory. The memory lives in your vault, never in the code repository: nothing to
commit, nothing to `.gitignore`, and clients' repositories stay clean.

```sh
node system/memory.mjs connect claude-code --projects   # or: connect codex --projects
```

Then open a new session in any project. Works the same on Windows, macOS and Linux: the hooks run
Node directly (no shell, no quoting of paths with spaces).

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

`connect --projects` writes a `projects` block into `memory.json`:

| key | default | meaning |
|---|---|---|
| `auto_add` | true | create the sector on the first session in a new repository |
| `checkpoint` | true | the end-of-session request for the handoff |
| `error_lookup` | true | look failed commands up in gotchas and dead ends |
| `autosync` | true when the vault has a remote | commit and push the vault when a session ends |
| `repos` | {} | repository → sector; edit it to move a project to another sector |

`connect claude-code --projects --remove` takes the hooks out again and keeps everything else in
`~/.claude/settings.json` (a backup goes to `.memory-kit/backups/connect/`). A settings file with
comments is never rewritten: the command prints the hooks to paste instead. `--dry-run` shows the
result without writing.

Hooks need Claude Code 2.1.139 or newer. Claude Code on the web does not read your user settings;
there the vault's own `CLAUDE.md` and `AGENTS.md` still work.
