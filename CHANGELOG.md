# Changelog

All notable changes to memory-kit are recorded here. The version is in `system/VERSION` and in the
`<!-- kit:start vX.Y.Z` marker of `AGENTS.md`. Each entry says which kit-owned files changed, so
that a manual upgrade ([docs/maintenance.md](docs/maintenance.md#upgrading-the-kit)) knows what to
replace or remove.

## Unreleased

Nothing yet.

## 0.1.0 (not released yet)

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
