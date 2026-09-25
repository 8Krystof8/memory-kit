# Changelog

All notable changes to memory-kit are recorded here. The version is in `system/VERSION` and in the
`<!-- kit:start vX.Y.Z` marker of `AGENTS.md`. From 0.1.1 on, `node system/memory.mjs upgrade`
applies a new version by itself ([docs/upgrading.md](docs/upgrading.md)); each entry still says
which kit-owned files changed.

## Unreleased

Nothing yet.

## 0.1.2 (2026-09-25, not released yet)

Memory for code projects, kept outside the code repositories and off unless you switch it on; a
setup wizard and an upgrade screen in the terminal; one-line installers and release tags. Nothing
changes for vaults that do not switch the project memory on; the data version stays 1.

### Added

- **`connect claude-code|codex --projects`** installs user-level hooks (`~/.claude/settings.json`,
  `~/.codex/hooks.json`) that work in the terminal, VS Code and JetBrains. They are one shell
  command each, which every Claude Code version runs: the Node.js that ran `connect`, by its full
  path (a repository that pins an older Node.js cannot break them), and the vault path in double
  quotes with forward slashes, so `/bin/sh`, Git Bash, PowerShell and cmd.exe read it alike. The
  exec form (no shell) is used only with `--form exec`, or for a vault path no shell passes on
  safely when every Claude Code seen here is 2.1.139 or newer; otherwise such a path is refused
  with its fix. The error lookup (PostToolUseFailure) is installed only when every Claude Code seen
  is 2.1.101 or newer (older ones ignore the whole settings file for an unknown event), SessionEnd
  only with `--autosync`. Other hooks and settings are kept, a backup is written, a file with
  comments is never rewritten (the hooks to paste are printed instead), `--remove` and `--dry-run`
  work ([docs/projects.md](docs/projects.md)). A Homebrew Cellar path (macOS and Linuxbrew) and a
  snap revision become their stable link, since `brew upgrade` and the snap refresh delete them.
- **`hook <agent> <event>`**, what the hooks run. They do nothing until `projects.enabled` is on,
  never write into the code repository and never fail a session (exit 0, also on Node.js older
  than 22). Session start: in a project, a brief (git state, handoff, conventions, gotchas, dead
  ends) and the start view narrowed to it; in a repository the vault does not know, a one-time
  two-line hint to the user (`project add`, `project ignore`); nothing extra inside the vault or
  outside git. Stop: one request per session to write the handoff when the code changed (a new
  commit, or uncommitted files that differ in their list, size or time from the session's start,
  which a compaction or resume keeps; worded neutrally when another session works in the same
  repository; never in `claude -p` or an Agent SDK run, whose result it would replace). The hooks read the code repository without git's optional locks, so they never
  take its `index.lock` or rewrite its index, and a git status that fails asks nothing. A failed
  Bash or PowerShell command (Claude Code) with at least 20 characters of error text, not an
  interrupt: a lookup in gotchas and dead ends, once per error and at most five per session; every
  other failed tool call ends before the vault config is loaded. Session end: with `autosync` on, a
  background commit and push of the vault under a lock, never over an unfinished merge or rebase;
  its commit gives the vault's pre-commit hook the hook's Node.js (`memorykit.node` for that
  commit, and first on the PATH), so a session started in a repository that pins an older Node.js
  does not make it refuse.
  The commands the hooks hand on (`project add`, `remember`, `doctor`, `sync`) name the Node.js of
  the hook by its full path, so they also work in a repository that pins an older Node.js.
- **A failure is never silent**: every hook run and every autosync step (lock, check, commit,
  pull, push) is logged in `.memory-kit/logs/hooks.jsonl` with the error and the fix (a
  local-store repository only as a hash); the next session start tells the user once, and
  `doctor` and `project status` list it.
- **`.memory-kit/` stays out of git in every clone**: it holds session records with the paths of
  code repositories, the hook log and copies of agent settings. A vault made by 0.1.0 has no
  `.gitignore` line for it, so the hooks, `project` and `connect --projects` add it to the clone's
  `.git/info/exclude` before the first file there; autosync commits nothing while git would take
  the folder or tracks files in it, and `doctor` (`git.repo`) says so with the fix. The ignore
  list and the root-commit cache kept there hold hashes, not repository URLs or paths.
- **`project add|remove|ignore|unignore|list|status`** (Czech `projekt` with
  `pridat|odebrat|ignorovat|neignorovat|seznam|stav`), run inside the code repository, all with
  `--json`. A repository is
  known by its remote (https, ssh, ssh host aliases and Azure DevOps forms give one key; a local
  remote by its path), else by its first commit; two servers are never taken for one repository.
  `memory.json` and `<local root>/projects.json` may start with a byte order mark (Windows
  PowerShell 5.1, older Notepad) and keep their line ends when written; a `projects.json` that is
  not valid JSON is never written over (the command says so and changes nothing).
- Every project's dev sector has the same note names (`overview`, `handoff`, `gotchas`…), so
  `check` lets those notes share names with each other; a second project no longer makes every
  vault commit and every autosync fail with `NAME_DUPLICATE`.
- **`remember "text" [--type …] [--project <sector>]`** (`zapamatuj`): one dated line into the
  right note of the project. In a repository that is not a project it goes into the inbox of the
  local root while the store is local; in the vault or outside any repository into `inbox/`.
  Secrets are refused.
- Project facts for the overview and the runbook from Node, Python, Rust, Go, PHP, Ruby,
  Java/Kotlin, .NET, Dart/Flutter and Deno projects, Makefiles, justfiles, Taskfiles and Compose
  files (read, never run; secrets left out).
- **`memory.json` key `projects`**, with these defaults: `enabled` false (the hooks do nothing),
  `auto_add` false (a new repository is not added by itself), `store` `"local"` (the notes and the
  repository links stay in the local root, the committed manifest is neutral: no project name, no
  URL), `autosync` false (nothing is committed or pushed by itself), `checkpoint` true,
  `error_lookup` true, `repos` {} (links of git-store projects only).
- **A setup wizard in the terminal**: `node system/init.mjs` without answers, and `setup`
  (`nastaveni`), ask the setup questions one screen at a time, show the plan and apply it only
  after a yes. A flag given is the answer and its question is not asked (the installers pass the
  mode they asked); `local` is not offered while the vault has a git remote. In a set-up vault
  `setup` offers: connect AI apps, memory for coding projects (the result as it really is: where
  the hooks are, where the notes stay and the next steps, or the refusal and its fix) and a health
  check.
- **The upgrade screen**: in a terminal, `upgrade` shows both versions, what is new (from this
  file), the plan and a question; an Enter typed before the question is on the screen does not
  answer it.
- **One-line installers**: `install.sh` (macOS, Linux) and `install.ps1` (Windows) check git and
  Node.js (they never install them), then make a new private GitHub repository from the template
  with a logged-in GitHub CLI (only after the mode is known: `local` never gets a remote), or
  download the kit without its history; then they run the setup. A folder whose GitHub remote is
  public and a new memory inside another git repository are refused; a folder that holds a memory
  gets `doctor` and `upgrade` instead.
- **Release tags**: a push to `main` of the public kit tags `v<version>` and publishes a GitHub
  Release with this file's section and the SHA-256 of both installers
  (`system/tools/release-notes.mjs`, `.github/workflows/release.yml`).
- **`doctor`** check `projects.hooks`: the hooks are complete and current, their Node.js and the
  Claude Code and Codex versions fit, `disableAllHooks` or a Codex setting does not switch them
  off, they ran since they were installed, and the failures of the last seven days and a failed
  sync with their fixes. `doctor --probe` also runs the session start hook the way the agent does;
  that run leaves no trace.

### Changed

- `upgrade --rollback` to a kit older than 0.1.2 first takes out the memory hooks of this vault
  (the older kit has no `hook` command, so every session would get a hook error and every Stop
  would be blocked) and says so; the recovery tool of the backup refuses instead and names the
  command to run first.
- `init` in an interactive terminal without answers opens the setup wizard (`--no-interactive`
  keeps the old behaviour); without a terminal its output is unchanged byte for byte.
- `upgrade` in a terminal shows the upgrade screen; its plain output is unchanged.
- `doctor` has 18 checks (`projects.hooks` is new) and the option `--probe`.
- On a Node.js older than 22, `hook` ends quietly with exit 0 and logs why (an agent hook must not
  fail a session); every other command still stops with exit 3.
- `help` lists the Czech subcommand aliases of `sector` and `project` next to the command aliases.

### Kit files

New: `install.sh`, `install.ps1`, `docs/projects.md`,
`system/lib/{projects,repofacts,hookinput,hooklog,hooksetup,nodepath,oldnode,tui,wizard,changelog}.mjs`,
`system/lib/commands/{hook,project,remember,setup}.mjs`, `system/tools/release-notes.mjs`, and new
tests. Changed: `system/memory.mjs`, `system/init.mjs`, `system/VERSION`, `system/lib/config.mjs`,
`system/lib/doctor.mjs`, `system/lib/kit.mjs`, `system/lib/commands/{connect,doctor,upgrade}.mjs`,
`system/lang/cs/pack.json`, `docs/architecture.md`, `docs/upgrading.md`, the kit markers of
`AGENTS.md` and `system/templates/*/kit/agents-system.md`. `.github/workflows/ci.yml` is the same
as in 0.1.1; `.github/workflows/release.yml` belongs to the public kit only. Removed: nothing.

### Testing

- The whole suite (`node --test "system/tests/**/*.test.mjs"`): 1252 tests, none failing; 5 skip
  themselves where the machine lacks what they need (Windows, a non-root user, Czech-only steps).
- `system/tests/integration/projects-e2e.test.mjs` crosses every module: `connect claude-code
  --projects --autosync` into a fake home, then each installed hook command run the way Claude
  Code runs it (`/bin/sh -c`; on Windows Git Bash or PowerShell) with its JSON on stdin, from the
  hint in an unknown repository to a failed push that the next session start and `doctor --json`
  report. It also proves that the code repository stays untouched, that no file git sees in the
  vault names the client, and that `memory.json` holds no repository URL.
- The installers run for real in a temporary home (install.sh under dash, install.ps1 under pwsh
  7), interactive runs in a pseudo-terminal, gh and the GitHub API as local fakes; shellcheck
  checks install.sh. The setup wizard and the upgrade screen are tested on a scripted fake
  terminal and in a real pseudo-terminal.
- CI runs the suite on Linux, Windows and macOS with Node 22 and 24. The work on 0.1.2 was run
  locally on Linux only (install.ps1 under pwsh 7 there); Windows and macOS rest on CI.

## 0.1.1 (2026-09-24, not released yet)

Foundations for the future: safe upgrades, a stable surface for other programs and apps, and
Windows and macOS next to Linux. Still no model calls. Your notes, `memory.json` and golden
questions stay as they are; the data version stays 1.

### Added

- **`upgrade`**: updates the kit in one command. It fetches the newest kit (`--from`, `kit.source`
  in memory.json as a git URL or a folder, or GitHub) and lets the newest upgrader run; prints the
  plan first and applies it only with `--yes`; replaces kit files only when you did not change them
  (the others are blocked, or kept with the new version next to them in
  `.memory-kit/upgrade/<to>/proposed/`); backs up every touched file in `.memory-kit/backups/` (5
  kept); verifies the vault with its own `check`, `start`, `search` and `eval` and rolls back by
  itself when anything fails; `--rollback [id]` undoes an upgrade. A 0.1.0 vault is upgraded once
  from a fresh clone of the kit (see the docs).
- **What keeps an upgrade and its rollback safe**
  ([docs/upgrading.md](docs/upgrading.md#backups-the-lock-and-undo)):
  - Before it writes, the backup records every file's bytes and the bytes the upgrade will leave
    there, so a rollback tells the upgrade's writes from later edits, also after an interruption.
    Backup ids are UTC times, so their order survives a time zone change and the DST hour.
  - A rollback (`--rollback`, the automatic one, the recovery tool) never overwrites a later
    change without a copy: a file changed after the upgrade refuses it, and `--force` restores it
    only after saving your version under `conflicts/` in the backup. Files the upgrade left as they
    were keep later edits (`memory.json`, the search log); generated files are restored without
    conflicts; a new file the upgrade cannot prove it wrote is never removed.
  - Files another program creates while the checks run are left alone and reported; files it
    changes are restored only after their current version is saved in the backup.
  - Notes in local roots that the checks normalize are saved inside their own root
    (`<local root>/.memory-kit/backups/<id>/`, never in the vault) and put back only while their
    text is unchanged.
  - Every backup carries a copy of the upgrader, `tool/rollback.mjs`, which undoes the upgrade when
    the vault's own code is half replaced; an upgrade that stops half way prints that command.
    Temporary files of a killed write are removed by the rollback.
  - The lock refuses a second upgrade and every `--rollback` while an upgrade still runs on this
    computer, and `--force` does not override that; the lock of an interrupted upgrade blocks until
    `--rollback`. An upgrade whose lock another command removed does not report success.
  - The text around the kit section of `AGENTS.md` stays byte for byte in any encoding; a UTF-16
    file is left alone and reported.
  - A vault in an untracked folder of another git repository counts as not under git, and a
    temporary clone that cannot be deleted only gives a warning.
- **Upgrade data**: `system/kit.json` (the files of this version and their hashes) and
  `system/kit-history.json` (the hashes of every release), written by the maintainers' tool
  `system/tools/release.mjs`; a data migration framework (`system/migrations/index.mjs`,
  `system/lib/migrations.mjs`) with no migration yet.
- **`doctor`**: 17 checks of the installation: Node, memory.json (with its schema), the data
  version, the kit files, the upgrade lock, the AGENTS.md markers, adapters, git hooks and
  attributes, roots, generated files, the platform and the connected apps. One line per check,
  with a fix for each problem; `--json` for scripts (doctor-result schema); `--fix` sets an unset
  `core.hooksPath` and repairs the pre-commit hook file byte by byte (removes a BOM and the CR
  bytes, adds the executable bit; the old file is kept in `.memory-kit/backups/doctor/`, and a
  symlinked hook stays a link). It also runs when memory.json is broken, and never writes without
  `--fix`. Run by a newer kit with `--root`, it checks a 0.1.0 vault too and names that kit's
  commands where the vault's kit has none.
- **MCP server** `node system/memory.mjs mcp [--read-only] [--local]`, part of the zero-dependency
  core: tools `memory_start`, `memory_search`, `memory_read`, `memory_recent` and `memory_inbox`
  (inbox writes only, never overwriting, secrets refused); local sectors stay hidden unless
  `--local`; `memory_start` gives the search rules of the tools instead of shell commands;
  `memory_read` reads a very long line in pieces (`column`); MCP versions 2024-11-05 to 2025-11-25
  and the 2026-07-28 era.
- **`connect <app>`** and **`connect --list`**: adds the memory to Claude Code, Claude Desktop,
  Cursor, VS Code, Windsurf, Gemini CLI, Codex, Zed, LM Studio, Cline, Copilot CLI and Junie, keeps
  every other setting, backs the file up first, never rewrites a file with comments or one it
  cannot read (it prints the entry to paste), and edits a symlinked settings file where the link
  leads; guidance for ChatGPT, the Claude app and JetBrains AI Assistant.
- **JS API** `system/api.mjs` (api_version 1): `openMemory(root)` with `start`, `search`, `read`,
  `recent`, `inbox`, `check`, `t` and `localValue`.
- **JSON schemas** (draft 2020-12) in `system/schema/` for memory.json, note frontmatter,
  `system/kit.json` and the `--json` outputs of `search`, `check` and `doctor`, with the
  zero-dependency validator `system/lib/schema.mjs`.
- `start --format text|gemini-hook|json`; `gemini-hook` feeds a Gemini CLI SessionStart hook.
- **Docs**: [docs/upgrading.md](docs/upgrading.md) (guarantees, ownership table, rollback, the
  0.1.0 bootstrap, version numbers, the release checklist), [docs/api.md](docs/api.md) (JS API,
  JSON output and schemas, MCP tools, the stability promise),
  [docs/integrations/mcp.md](docs/integrations/mcp.md) (every app, its settings file per OS,
  troubleshooting), and optional SessionStart hooks for Codex and Gemini CLI.
- Check rules `NAME_PORTABLE` (a name Windows cannot hold) and `CASE_MISMATCH` (a hub, manifest,
  export or rules file whose name differs only in letter case).
- Czech aliases: `doktor`, `aktualizuj`, `pripoj` and the flags `--ano`, `--nanecisto`,
  `--vratit`, `--odkud`, `--bez-overeni`, `--rozsah`, `--jmeno`, `--odebrat`, `--seznam`,
  `--jen-cteni`, `--lokalni`. The Czech pack now translates every message, `eval` included.

### Changed

- **Windows and macOS**: the home folder comes from the OS (`~\` works too); existing files are
  rewritten atomically and renames retry while Windows holds a lock (a failed sector move is rolled
  back); child processes never open a console window; note names are compared in NFC (macOS);
  hubs, manifests and rules files are found by their exact letter case; `desktop.ini`,
  `Thumbs.db`, `.DS_Store` and similar files are ignored; a CRLF checkout of a generated file is
  not "edited by hand"; `new`, `sector add` and `init` refuse Windows device names; a local root
  written for another OS is reported instead of used, and one inside the repository is refused;
  `init` refuses a private folder on another drive; a sector move that falls back from `git mv`
  is staged whole or not at all (then `sector` says to run `git add -A`).
- `.claude/settings.json`: the SessionStart hook's placeholder is braced and quoted
  (`node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start`), so spaces in the path work and
  PowerShell works from Claude Code 2.1.198 on. It stays a shell command, because Claude Code
  before 2.1.139 ignores the exec form's `args`. It also runs after `/clear`.
- `.githooks/pre-commit` finds a Node.js 22 or newer for GUI git clients too (the
  `git config memorykit.node <path>` pin, the `PATH`, Homebrew, `/usr/local`, Volta, nvm) and
  passes over older ones. When the pinned node or the one on the `PATH` is too old and no newer one
  exists, it refuses the commit and says how to fix it.
- A note left in a local sector's folder of the main vault (`LOCAL_IN_GIT`) is only counted:
  search, the start view, `_ai/`, the home page and the search log leave it out.
- `sync` can no longer hang on a git prompt or editor, and reports a `.git` git cannot use.
- `init` and the READMEs print commit commands one per line (Windows PowerShell 5.1 has no `&&`).
- `memory.mjs` stops with a clear message on Node older than 22; `doctor`, `upgrade` and `mcp` also
  start with a broken memory.json, under their localized names too. A memory.json with a newer data
  version asks for `upgrade`.
- CI tests the kit on Linux, Windows and macOS with Node 22 and 24 and checks `system/kit.json`.
- `.gitignore` of new vaults: `.memory-kit/` (local state of `upgrade`, `connect` and `doctor`), `desktop.ini`,
  `ehthumbs.db`, `ehthumbs_vista.db`.

### Kit files

New: `system/api.mjs`, `system/kit.json`, `system/kit-history.json`,
`system/lib/{fsafe,startview,kit,upgrade,migrations,schema,doctor,mcp,clients,jsonc}.mjs`,
`system/lib/commands/{doctor,upgrade,connect,mcp}.mjs`, `system/schema/`, `system/migrations/`,
`system/tools/`, `docs/upgrading.md`, `docs/api.md`, `docs/integrations/mcp.md`, and new tests.
Changed: most of `system/lib/`, `system/memory.mjs`, `system/init.mjs`, `system/VERSION`,
`system/lang/cs/pack.json`, the kit markers of `AGENTS.md` and
`system/templates/*/kit/agents-system.md`, `.claude/settings.json`, `.githooks/pre-commit`,
`.github/workflows/ci.yml`, `docs/`. Removed: nothing. `upgrade` applies all of this; a 0.1.0 vault
is upgraded once from a fresh clone of the kit
([docs/upgrading.md](docs/upgrading.md#upgrading-a-vault-made-from-010)).

## 0.1.0

The first version (phase 1). It makes no model calls.

### Added

- **Vault structure**: markdown notes with YAML frontmatter as the single source of truth; sectors
  as top-level modules with manifests (`sectors/<id>/_<id>.md`) and the states on, sleep and off;
  15 note types and one list of five statuses; `inbox/`, `journal/`, `archive/`, `attachments/`,
  and the hubs `state.md` and `waiting.md`. No editor is required: people read the generated
  home page on GitHub or in any markdown editor.
- **Language packs** for English and Czech (`system/lang/<code>/pack.json`): folder and file names,
  frontmatter keys, types, statuses, labels, messages, CLI aliases, stopwords, accent classes and
  sector presets. The Snowball stemmers for English and Czech (BSD 3-clause).
- **CLI** `node system/memory.mjs` with the commands `start`, `check`, `search`, `new`, `sector`,
  `sync` and `eval`, and localized aliases (Czech: `hledej`, `kontrola`, `novy`, `sektor`,
  `synchronizuj`).
- **Generated views**: the home page for people (`home.md`, cs `domu.md`: plain markdown with
  ordinary links) and the AI view in `_ai/` (`start.md`, `index-<sector>.md`, `catalog.tsv`,
  `profile.md`) and `.ignore`. The output is deterministic, with `source` and `content` fingerprints that tell a
  stale view from a hand-edited one.
- **Search**: SQLite FTS5 through `node:sqlite` with weighted columns and stemmed metadata, a
  pure-JavaScript fallback engine with the same ranking, accent-free queries (`ascii_endings`), accent-safe regexes (`--rg`), a duplicate check
  (`--duplicates`), and JSON output.
- **Checks**: about 50 rules in three kinds (system, data, warn), with strict and lenient modes;
  budgets; secret scanning; privacy rules for local sectors (`PRIVACY_LINK`, `LOCAL_IN_GIT`).
- **Setup** with `system/init.mjs`: the modes github, local and combined, a language, sector
  presets, a private folder for local sectors, and `--questions` so an agent can ask the user.
- **Adapters**: `AGENTS.md` (a system section between markers, the search protocol, a personal
  section), `CLAUDE.md`, `GEMINI.md`, the skill `.agents/skills/memory/` (and the same file in `.claude/skills/memory/`), the Claude Code subagent
  `memory-searcher`, and the SessionStart hook.
- **Templates** for every note type in both languages.
- **Git integration**: a pre-commit hook (`check --pre-commit`: refuses partly staged files, then a
  strict check plus regeneration), a managed `.gitignore` block that keeps local sector content out
  of git even without the hook, and `sync` with `pull --rebase` that resolves conflicts only in
  generated files, never forces and never pushes in mode local.
- **Golden questions** and `eval` (hit@3 by category); English and Czech fixture vaults with
  fictional data.
- **CI** for the public kit (tests on Node 22 and 24, a strict check), a nightly lenient check for
  private vaults, and a guard that fails when a set-up vault is in a public repository.
- **Docs**: README (English and Czech), modes, privacy, phone setup, search, maintenance with the
  roadmap, and guides for Claude Code, Codex, Gemini CLI, Cursor, ChatGPT and the Claude app.
