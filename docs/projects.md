# Memory for your code projects

One command, and the repositories you choose in Claude Code (terminal, VS Code, JetBrains) or Codex
get their own memory. The memory lives in your vault, never in the code repository: nothing to
commit, nothing to `.gitignore`, and clients' repositories stay clean.

```sh
node system/memory.mjs connect claude-code --projects   # or: connect codex --projects
```

Then open a new session in any project. Works the same on Windows, macOS and Linux: the hooks run
Node directly (no shell, no quoting of paths with spaces).

## What happens by itself

| when | what the memory does |
|---|---|
| a session starts in a repository the vault does not know | tells you once per repository, in two lines, how to give it a memory (`project add`) or silence the hint (`project ignore`). Nothing is added by itself, unless `auto_add` is on |
| a session starts in a project | shows the agent the branch, uncommitted files, last commits, the handoff, conventions, gotchas and dead ends of *this* project, plus the start view narrowed to it |
| a session starts anywhere | tells you, once per failure, when the last sync or a hook run failed, with the fix |
| the agent finishes and the code changed | asks it once per session to rewrite the handoff and record fixed errors, dead ends and decisions (no extra model call: the agent is running anyway) |
| a Bash or PowerShell command fails (Claude Code) | looks the error up in the project's gotchas and dead ends and hands a match (three lines at most) to the agent; interrupts, short errors and repeats are skipped, and a session makes five lookups at most |
| the session ends | with `autosync` on: commits and pushes the vault in the background, never over a merge or rebase you have not finished |

Inside the vault and outside any git repository the hooks give the agent nothing extra. Claude Code
shows what is meant for you as a message of its own; Codex has no such message, so the agent is
asked to pass it on.

## Adding a project

Run the command inside the code repository:

```sh
node /path/to/vault/system/memory.mjs project add
```

| command | what it does |
|---|---|
| `project add [--store local\|git] [--title "…"]` | gives this repository a dev sector and its notes (see [where the notes live](#where-the-notes-live)) |
| `project remove` | unlinks the repository and says where its notes stay (`sector off` archives them) |
| `project ignore`, `project unignore` | silences the hint of the session start in this repository, or brings it back |
| `project list` | every project: sector, store, repository, last session |
| `project status` | this repository, the settings, the last hook runs, recent failures and the autosync lock |

Every subcommand takes `--json`. In Czech: `projekt pridat`, `odebrat`, `ignorovat`,
`neignorovat`, `seznam` and `stav`.

The repository is recognised by its `origin` remote (`github.com/owner/repo`, the same for https
and ssh clones and for an ssh host alias such as `github.com-work`), else by its first remote, else
by its first commit, so a second clone, a worktree or another computer finds the same project. A
repository without a commit cannot be added yet. Two servers are never taken for one repository,
even when the owner and the name match (`github.com/team/website` and
`gitlab.example.com/team/website` are two projects). A repository found only through a host alias
says so in `project status`; `project ignore` there stops that, `project add` gives it a project of
its own.

## Where the notes live

With `store` `local` (the default) the notes of a project and the list of your repositories stay
on this computer, in the vault's local root (`../<vault folder>-private`, made when the vault has
none): `sectors/dev/…` there, and `projects.json` with the repository → sector links and the ignore
list. The vault repository gets only a neutral manifest, `sectors/dev/_dev.md` ("Dev (local)"):
no project name, no repository address. The sectors are called `dev`, `dev-2`, `dev-3`…

With `store` `git` the notes go into the vault repository like any other sector and are synced
with it; the sectors are called `dev`, then `dev-<name>`, and `memory.json` `projects.repos` links
the repositories.

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
`slepe-ulicky`, `mapa` and `zapisnik`. The overview and the runbook start from what the repository
says about itself: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, the
`Gemfile`, Maven and Gradle files, .NET solutions, `pubspec.yaml`, `deno.json`, Makefiles,
justfiles, Taskfiles and Compose files are read (never run), and anything that looks like a secret
is left out.

## Recording by hand

```sh
node /path/to/vault/system/memory.mjs remember --project dev --type gotcha "vite: ENOSPC → inotify limit → raise max_user_watches"
```

Without `--project`, run it inside the code repository and it finds the project. Types: `gotcha`,
`dead-end`, `todo`, `run`, `convention`, `decision`, `fact` (default). In a repository that is not
a project yet the text goes to the inbox of the local root while the store is local, so a note
about a client never reaches git by itself; in the vault or outside any repository it goes to
`inbox/`. Text with a secret in it is refused.

## The hook log

Every hook run adds a line to `.memory-kit/logs/hooks.jsonl` in the vault (never committed; a
local-store repository appears only as a hash): the event, whether it worked, how long it took and,
for autosync, the failing step (`lock`, `check`, `commit`, `pull` or `push`), the error and the
fix. `project status` and `doctor` show it, and the next session start tells you about a new
failure.

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
