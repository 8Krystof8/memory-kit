# Contributing

Thank you for helping. memory-kit is small on purpose, and a few rules keep it that way. Please
read them before you open a pull request.

## Ground rules

1. **The contract comes first.** [docs/architecture.md](docs/architecture.md) is binding. When
   behavior changes, change the contract in the same pull request. When the code and the contract
   disagree, the contract wins.
2. **No dependencies.** Node 22 or newer, ES modules (`.mjs`), built-in modules only (`node:fs`,
   `node:path`, `node:crypto`, `node:child_process`, `node:util`, `node:sqlite`, `node:test`…). No
   `package.json` anywhere: the MCP server, `connect` and the JS API are part of the same
   zero-dependency core.
3. **Determinism.** Generators, `check`, `search` and `eval` never read the clock, `Math.random`,
   locale settings, hostnames, file times or commit hashes. Sort by explicit keys and break ties by
   path with plain code-unit comparison (never `localeCompare`). Print numbers with `String(n)` or
   `toFixed`, never `toLocaleString`. The same input must give byte-identical output on every
   machine.
4. **English code, localized words.** Identifiers, comments, CLI names and docs are English. Every
   word a user sees in a vault (folders, keys, types, statuses, labels, messages, aliases) comes
   from a language pack. Code uses canonical English keys and maps through the pack. Every message
   has an English default in code, so a missing translation can never break a run.
5. **Budgets are law.** Do not raise a limit to make something fit. Trim, split, or propose a
   change to the contract with measurements.
6. **Nothing private, ever.** This repository is public. No real people, companies, schools,
   places, domains, prices, emails or note titles from anyone's real memory. Examples and fixtures
   use obviously fictional data: the design studio "Linden Studio", its client "Harbor Bakery",
   "Northfield School", invented people. In Czech fixtures: "Pekárna U Přístavu", "Střední škola
   Severka".
7. **No literal secrets.** Not even fake ones: the secret scanner runs over the whole repository.
   Tests build key-shaped strings at runtime (`plantSecret()` in `system/tests/helpers.mjs`), and
   the scanner builds its own patterns from string pieces.
8. **Every OS.** The kit runs on Windows, macOS and Linux. Child processes get no shell and
   `windowsHide: true`; existing files are rewritten through `system/lib/fsafe.mjs`; paths inside
   the vault are POSIX strings joined with `path.join(root, ...rel.split('/'))`; printed commands
   stand one per line (Windows PowerShell 5.1 rejects `&&`).

## Getting started

```sh
git clone https://github.com/8Krystof8/memory-kit.git
cd memory-kit
node --test "system/tests/**/*.test.mjs"     # unit and integration tests
node system/memory.mjs check --strict         # the empty kit must pass its own check
node system/tools/release.mjs --check         # system/kit.json matches the files
```

Tests never touch the repository itself. They copy the kit into a temporary folder and pass
`--root`. Set `MEMORY_KEEP_TMP=1` to keep those folders for inspection. Set `MEMORY_DEBUG=1` to get
stack traces for internal errors (exit code 3).

To try the kit by hand, make a throwaway clone next to the checkout and set it up there. The clone
holds the committed state, so commit first. Run the commands one at a time; they work the same in
bash, zsh and PowerShell:

```sh
git clone . ../kit-try
node ../kit-try/system/init.mjs --root ../kit-try --mode github --lang cs --sectors core,work,school --yes
node ../kit-try/system/memory.mjs hledej "práce"
```

Delete `../kit-try` when you are done.

To try `upgrade`, run `node system/tools/release.mjs` in your checkout, then let your checkout
upgrade a vault made from an older release: `node system/memory.mjs upgrade --root ../old-vault`
prints the plan, and `--yes` applies it.

To force the pure-JavaScript search engine: `MEMORY_SEARCH_ENGINE=scan`.

## Where things live

| area | files |
|---|---|
| CLI entry | `system/memory.mjs` (maps localized aliases, dispatches to `system/lib/commands/<command>.mjs`) |
| setup | `system/init.mjs` |
| public JS API | `system/api.mjs` (`openMemory`, api_version 1), used by the MCP server too |
| library | `system/lib/`: `util` ← `config` ← `frontmatter` ← `vault`; `fingerprint`, `text` ← `search`; `generate` ← `check`; `secrets`; `eval`; `fsafe` (atomic writes, retries); `startview` (the start view); `kit`, `upgrade`, `migrations` (upgrades); `schema` (JSON Schema validator); `doctor` (the checks of `doctor`, read-only); `mcp` (MCP protocol); `clients`, `jsonc` (connect) |
| commands | `system/lib/commands/{start,check,search,new,sector,sync,eval,doctor,upgrade,connect,mcp}.mjs`: each exports `usage` and `run(argv, cfg, ctx)`; `doctor`, `upgrade` and `mcp` also run with `cfg = null` when memory.json is broken. A new command also needs its `usage` line in `system/memory.mjs` help, a row in section 10.1 of the contract and, when it prints, a `DEFAULTS` table of English messages |
| maintainer tools | `system/tools/release.mjs` (not used in a vault) |
| upgrade data | `system/kit.json`, `system/kit-history.json` (written by `system/tools/release.mjs`), `system/migrations/index.mjs`; which group a new file belongs to (code, tests, docs, config) is decided by its path in `groupOf` of `system/lib/kit.mjs` ([docs/upgrading.md](docs/upgrading.md#which-files-change)) |
| schemas | `system/schema/*.schema.json` (memory.json, note frontmatter, kit.json, and the `--json` outputs of search, check and doctor) |
| languages | `system/lang/<code>/pack.json`, `stemmer.mjs`; `system/lang/snowball-base.mjs`; `system/lang/LICENSE-snowball.txt` |
| templates | `system/templates/<code>/notes/` (one per note type, used by `new`), `system/templates/<code>/kit/` (rules, hubs, manifests, used by code) |
| tests | `system/tests/unit/`, `system/tests/integration/`, `system/tests/fixtures/<code>/`, `system/tests/helpers.mjs` |
| adapters | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.agents/skills/memory/`, `.claude/`, `.githooks/` |

Modules import each other only along the arrows in section 7 of the contract. `generate` loads
`check` with a dynamic import, so there is no static cycle. Keep functions small, and give errors
messages that say what to do. Commands set `process.exitCode` and return; never call
`process.exit()`. Exit codes: 0 ok, 1 a problem found, 2 a usage error, 3 an internal error.

Every file the kit writes is UTF-8, LF, NFC, without a BOM, and ends with exactly one newline.

## Changing the rules files

The system section of `AGENTS.md` (between `<!-- kit:start` and `<!-- kit:end -->`) is kit code.

- The root `AGENTS.md`, with its setup block removed, must equal
  `system/templates/en/kit/agents-system.md` byte for byte. A test checks this. Edit both.
- Update the Czech `system/templates/cs/kit/agents-system.md` too. It is a full translation with
  localized paths; commands and their order stay the same.
- Budgets: the whole file ≤ 150 lines and 8,000 characters, the system section ≤ 110 lines and 6,000
  characters, and the search block (between `<!-- search:start -->` and `<!-- search:end -->`)
  ≤ 1,600 bytes. The search block is copied into every session start, so every byte counts.
- `CLAUDE.md` stays at most 25 lines. `GEMINI.md` is exactly `@AGENTS.md`.
- Never touch the `## Personal rules` section in templates beyond its default comment. It belongs
  to users.

## Adding a language

1. **Pack.** Copy `system/lang/en/pack.json` to `system/lang/<code>/pack.json` and translate every
   value. A parity test requires every key of the English pack. Folder and file names must be
   ASCII lowercase with hyphens, and localized values must be unique within their table (no two
   types with the same word). Include:
   - `stopwords` for queries;
   - `diacritic_classes` for `search --rg` (empty if the language has no accents);
   - `generic_names` (forbidden file names such as "notes" or "untitled");
   - all eight `sector_presets`, each with at least five `keywords` including inflected forms and
     ASCII spellings, and texts without people, companies or places;
   - the three `start_safety` lines;
   - every `labels` key (including the `home.*` labels of the generated home page);
   - a translation of every message the code prints (`messages`; the English texts live in the
     `DEFAULTS` tables of the code, and `pack.test.mjs` lists what is missing);
   - CLI aliases in `commands`, `subcommands` and `flags` (canonical names keep working). Flag
     aliases apply to every command, so an alias must not be a flag of any command, and each flag
     gets at most one alias.
2. **Stemmer.** Add `system/lang/<code>/stemmer.mjs` exporting `stem(word)`. Prefer a stemmer
   generated from [Snowball](https://snowballstem.org/) with the shared `snowball-base.mjs`, and
   record its source and license in `system/lang/LICENSE-snowball.txt`. Without one, set
   `"stemmer": "none"`: search then relies on prefixes and `keywords`.
3. **Templates.** Add `system/templates/<code>/notes/<localized type>.md` for all 13 note types
   (every type except `sector` and `hub`), with localized keys and values. Add
   `system/templates/<code>/kit/` with `agents-system.md`, `agents-personal.md`,
   `state.md`, `waiting.md`, `profile.md`, `sector.md` and `export.md`.
4. **Fixtures.** Add `system/tests/fixtures/<code>/vault/`, `private/` and `golden.json`. Follow
   the English and Czech fixtures: at least 30 notes covering every type, real inflection in note
   bodies, and at least 20 golden questions with at least three per category. Phrase some questions
   with other word forms than the notes use, and type some without accents.
5. **Measure.** `eval` on the new fixtures must reach hit@3 ≥ 0.9 with `fts5` and ≥ 0.8 with the scan
   engine.
6. **Docs.** Mention the language in the README and, if you like, add a `README.<code>.md`.

## Adding or changing a check rule

1. Add it to `RULES` in `system/lib/check.mjs` with its kind: `system` (always an error), `data`
   (an error in strict mode, a warning in lenient) or `warn`.
2. Give it an English default message in `CODE_DEFAULTS` (`system/lib/config.mjs`) and a
   `check.<CODE>` translation in every pack except English.
3. Add a unit test that triggers it, and one that shows the kit and the fixtures stay clean.
4. Document it in section 11 of the contract, and in the table of common findings in
   [docs/maintenance.md](docs/maintenance.md#common-findings-and-their-fixes) if users will meet it.

## Tests

- `node:test` and `node:assert` only.
- Pass `--today YYYY-MM-DD` wherever dates matter. Fixtures use dates relative to the fixed test
  date in `helpers.mjs`.
- Fixture notes must pass `check --strict`, except in tests that break them on purpose.
- The integration tests prove the properties users rely on: setup in both languages, determinism
  (byte-identical `_ai/` on a second copy), budgets, search in Czech with and without accents on both
  engines, secret and privacy blocking, the sector lifecycle, hand-edit detection, and eval. Keep
  them green on Node 22 and 24 on Linux, Windows and macOS. CI runs all six. Tests that need a
  particular OS or tool skip themselves elsewhere (with the reason), and simulate other platforms
  through `path.win32` or an injected platform where they can.
- A new message key needs its Czech text in `system/lang/cs/pack.json` in the same change;
  `pack.test.mjs` fails otherwise.
- Commands shown in the docs must run the same in bash, zsh and PowerShell: one command per line
  (no `&&`), and no `~` in a path handed to `node` (Windows PowerShell 5.1 and cmd pass it on
  unchanged). `docs.test.mjs` checks the second rule.
- `system/lib/upgrade.mjs`, `kit.mjs`, `fsafe.mjs` and `migrations.mjs` are copied into every
  upgrade backup as its recovery tool (`tool/rollback.mjs`), so they import only `node:` modules
  and each other. The recovery tests in `upgrade-recovery.test.mjs` run that copy.

## Releasing

`upgrade` trusts `system/kit.json`: it refuses a kit whose files do not match it, and it replaces a
vault file only when its content is one a release shipped (`system/kit-history.json`). The full
checklist is in [docs/upgrading.md](docs/upgrading.md#releasing-a-new-version-maintainers). In
short:

1. Starting a new version: set `system/VERSION` and the `<!-- kit:start vX.Y.Z` line of `AGENTS.md`,
   `system/templates/en/kit/agents-system.md` and `system/templates/cs/kit/agents-system.md` before
   the first `release.mjs` run of that version. Otherwise the run overwrites the history entry of
   the version already released.
2. After changing any kit file, run `node system/tools/release.mjs`. It rewrites `system/kit.json`
   from the working tree and records this version's hashes in `system/kit-history.json`.
   `kit-manifest.test.mjs` and the CI step `node system/tools/release.mjs --check` fail while
   kit.json is stale.
3. A data format change needs a migration in `system/migrations/index.mjs` (`{id, from, to, title,
   run(ctx)}`; it rewrites or moves, never deletes) and a test that upgrades a vault through it.
   A breaking change of `system/api.mjs` raises its `API_VERSION` ([docs/api.md](docs/api.md#stability-promise)).
4. Add the version's section to [CHANGELOG.md](CHANGELOG.md), with the date and the kit files that
   were added, changed or removed.
5. Run the tests, `release.mjs --check`, `check --generate` and `check --strict` at the kit root,
   commit, and tag the commit `v<version>`.

## Generated files in this repository

`_ai/` and `.ignore` at the kit root are generated by `node system/memory.mjs check --generate`.
Never edit them by hand. The pre-commit hook regenerates and stages them when `core.hooksPath` is
set (`git config core.hooksPath .githooks`).

## Pull requests

- One topic per pull request; small commits with plain messages.
- Checklist:
  - [ ] `node --test "system/tests/**/*.test.mjs"` passes
  - [ ] `node system/memory.mjs check --strict` passes on the kit root
  - [ ] `node system/tools/release.mjs` was run, so `--check` passes
  - [ ] the contract and docs are updated when behavior changed
  - [ ] a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md)
  - [ ] no private data, no literal secrets, no new dependencies

## License

By contributing, you agree that your contributions are licensed under the MIT license of this
repository. The Snowball stemmers keep their BSD 3-clause license
([system/lang/LICENSE-snowball.txt](system/lang/LICENSE-snowball.txt)).
