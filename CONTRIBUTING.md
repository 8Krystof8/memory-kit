# Contributing

Thank you for helping. memory-kit is small on purpose, and a few rules keep it that way. Please
read them before you open a pull request.

## Ground rules

1. **The contract comes first.** [docs/architecture.md](docs/architecture.md) is binding. When
   behavior changes, change the contract in the same pull request. When the code and the contract
   disagree, the contract wins.
2. **No dependencies.** Node 22 or newer, ES modules (`.mjs`), built-in modules only (`node:fs`,
   `node:path`, `node:crypto`, `node:child_process`, `node:util`, `node:sqlite`, `node:test`…). No
   `package.json` in the core. Optional modules on the roadmap (the MCP server) get their own.
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

## Getting started

```sh
git clone https://github.com/8Krystof8/memory-kit.git
cd memory-kit
node --test "system/tests/**/*.test.mjs"     # unit and integration tests
node system/memory.mjs check --strict         # the empty kit must pass its own check
```

Tests never touch the repository itself. They copy the kit into a temporary folder and pass
`--root`. Set `MEMORY_KEEP_TMP=1` to keep those folders for inspection. Set `MEMORY_DEBUG=1` to get
stack traces for internal errors (exit code 3).

To try the kit by hand, make a throwaway copy and set it up there:

```sh
tmp=$(mktemp -d) && cp -R . "$tmp" && rm -rf "$tmp/.git"
node "$tmp/system/init.mjs" --root "$tmp" --mode github --lang cs --sectors core,work,school --yes
node "$tmp/system/memory.mjs" hledej "práce"
```

To force the pure-JavaScript search engine: `MEMORY_SEARCH_ENGINE=scan`.

## Where things live

| area | files |
|---|---|
| CLI entry | `system/memory.mjs` (maps localized aliases, dispatches to `system/lib/commands/<command>.mjs`) |
| setup | `system/init.mjs` |
| library | `system/lib/`: `util` ← `config` ← `frontmatter` ← `vault`; `fingerprint`, `text` ← `search`; `generate` ← `check`; `secrets`; `eval` |
| commands | `system/lib/commands/{start,check,search,new,sector,sync,eval}.mjs`: each exports `usage` and `run(argv, cfg)` |
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
   - CLI aliases in `commands`, `subcommands` and `flags` (canonical names keep working).
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
2. Give it an English default message and a `check.<CODE>` translation in every pack.
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
  them green on Node 22 and 24. CI runs both.

## Generated files in this repository

`_ai/` and `.ignore` at the kit root are generated by `node system/memory.mjs check --generate`.
Never edit them by hand. The pre-commit hook regenerates and stages them when `core.hooksPath` is
set (`git config core.hooksPath .githooks`).

## Pull requests

- One topic per pull request; small commits with plain messages.
- Checklist:
  - [ ] `node --test "system/tests/**/*.test.mjs"` passes
  - [ ] `node system/memory.mjs check --strict` passes on the kit root
  - [ ] the contract and docs are updated when behavior changed
  - [ ] a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md)
  - [ ] no private data, no literal secrets, no new dependencies

## License

By contributing, you agree that your contributions are licensed under the MIT license of this
repository. The Snowball stemmers keep their BSD 3-clause license
([system/lang/LICENSE-snowball.txt](system/lang/LICENSE-snowball.txt)).
