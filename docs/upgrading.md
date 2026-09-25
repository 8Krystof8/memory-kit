# Upgrading memory-kit

One command updates the kit code in your vault. It never touches your notes, and it checks its own
work before it finishes. This page explains what the command promises, what it does step by step,
and how to undo it. The last part is for maintainers who publish a new version.

## Contents

- [What an upgrade promises](#what-an-upgrade-promises)
- [Upgrade in four commands](#upgrade-in-four-commands)
- [What happens, step by step](#what-happens-step-by-step)
- [Which files change](#which-files-change)
- [When the upgrade stops](#when-the-upgrade-stops)
- [Backups, the lock and undo](#backups-the-lock-and-undo)
- [Data migrations](#data-migrations)
- [Upgrading a vault made from 0.1.0](#upgrading-a-vault-made-from-010)
- [Where the new kit comes from](#where-the-new-kit-comes-from)
- [All options](#all-options)
- [Version numbers](#version-numbers)
- [Releasing a new version (maintainers)](#releasing-a-new-version-maintainers)

## What an upgrade promises

- **Your data stays as it is.** Notes, hubs, the inbox, the journal, the archive, `memory.json`,
  your golden questions and your local sectors are never overwritten. The only exception is a data
  migration (see [Data migrations](#data-migrations)), and 0.1.1 has none.
- **Nothing happens until you agree.** In a terminal, `upgrade` shows the plan and asks before it
  changes anything; an Enter pressed before the question is on the screen is not an answer.
  Everywhere else (an AI agent, a script, CI) it only prints the plan unless you pass `--yes`.
- **Your own changes are never lost silently.** A kit code file you changed stops the upgrade. A
  config or docs file you changed stays as it is, and the new version is saved next to it for you
  to compare. A file that you or another program change while the upgrade runs, or after it, is
  never overwritten without a copy.
- **Every file it touches is backed up first.** The backup stays in `.memory-kit/backups/`,
  together with a copy of the upgrader that can undo it.
- **It checks the result.** After the upgrade it runs your vault's own `check`, `start`, `search`
  and golden questions. If anything fails, it puts every file back, byte for byte.
- **It can be undone.** `upgrade --rollback` restores the backup, also after an interrupted
  upgrade.

## Upgrade in four commands

Run these in your vault folder, one at a time. They work the same in bash, zsh and PowerShell.

```sh
node system/memory.mjs upgrade
node system/memory.mjs upgrade --yes
git add -A
git commit -m "memory-kit 0.1.1 → 0.1.2"
```

1. The first command downloads the newest kit and prints the plan. It changes nothing.
2. The second command applies the plan.
3. The last two commit the result. `upgrade` prints the exact commit command for your versions.

In a terminal, a vault on 0.1.2 or newer does the first two steps in one: `upgrade` shows the plan
and what is new, then asks `Upgrade to 0.1.3 now?`. Answer `y` to apply it or `n` to leave
everything as it is; the second command is then not needed. An Enter you press while the kit
downloads or the plan is computed does not count as an answer. Without a terminal `upgrade` never
asks: it prints the plan and changes nothing, and only `--yes` applies it. A vault on 0.1.1 hands
over to the new upgrader without a terminal, so there the two commands above are the way.

In the Czech pack the command is `aktualizuj`, and `--ano` means `--yes`.

A plan looks like this (0.1.2 stands for whatever version is newest):

```text
$ node system/memory.mjs upgrade
fetching memory-kit from https://github.com/8Krystof8/memory-kit.git
memory-kit 0.1.2 found in https://github.com/8Krystof8/memory-kit.git; its upgrader takes over
memory-kit upgrade 0.1.1 → 0.1.2
source: /tmp/memory-kit-upgrade-6ZP8fA/kit
kit files: 0 new, 4 updated, 0 removed, 227 unchanged
AGENTS.md: the kit section is replaced with system/templates/en/kit/agents-system.md; your text around it stays as it is
Plan only, nothing was changed. To apply it:
  node system/memory.mjs upgrade --yes
```

And the upgrade itself ends like this:

```text
upgraded 0.1.1 → 0.1.2 · backup 20260924-162948-0.1.1-to-0.1.2
verified with the vault's own commands: check, start and search work
golden questions: hit@3 1.00 before, 1.00 after
next steps:
  git add -A
  git commit -m "memory-kit 0.1.1 → 0.1.2"
to undo it: node system/memory.mjs upgrade --rollback 20260924-162948-0.1.1-to-0.1.2
```

When your vault already has the newest version, `upgrade` says
`memory-kit 0.1.1 is up to date (the source has 0.1.1).` and exits 0. The same number is not
enough, though: when the source's `system/kit.json` lists other files or hashes (another build of
that version, such as a draft published under its number), it is an upgrade like any other, and
the plan says so (`this vault has another build of …`). From 0.1.2 on, a vault's own `upgrade`
hands over to that build. A vault that took the draft of 0.1.2 from `main` on 25 September 2026
still says "up to date", since its own upgrader predates this: download the kit and run
`node <kit>/system/memory.mjs upgrade --root <vault>` once, then `connect claude-code --projects`
again (the draft's hooks do nothing until then) or `connect claude-code --projects --remove`.

## What happens, step by step

### 1. The newest upgrader takes over

`upgrade` fetches the new kit into a temporary folder. When that kit is newer than yours, its own
`upgrade` command runs instead of yours. So the upgrade logic is always the newest one, and fixes
to the upgrader reach you in the same step.

### 2. The plan

The plan is computed without writing anything. It compares every kit file of your vault with the
new kit and gives each file one action:

| action | meaning |
|---|---|
| `add` | the file is new in this version; it is added |
| `replace` | you did not change the file; the new version replaces it |
| `unchanged` | the file is the same in both versions |
| `blocked` | you changed a code or tests file; the upgrade stops (see [When the upgrade stops](#when-the-upgrade-stops)) |
| `force` | you changed a code or tests file and passed `--force`; it is replaced, the backup keeps yours |
| `propose` | you changed a config or docs file; yours stays, the new version goes to `.memory-kit/upgrade/<version>/proposed/` |
| `skip` | the file is optional here (for example you deleted `docs/`), so it is not added |
| `remove` | an older kit shipped the file, the new one does not, and you did not change it; it is removed |
| `keep` | like `remove`, but you changed the file, so it stays and is reported |

"You did not change the file" has an exact meaning: its content equals a version that some kit
release shipped. `system/kit-history.json` records the hash of every file of every release. Line
endings, a byte order mark and the Unicode form do not count, so a Windows checkout with CRLF line
endings is still "unchanged".

The plan also covers the kit section of `AGENTS.md` and the data migrations, if any.

### 3. Apply

With `--yes` the upgrade:

1. checks that git shows no uncommitted changes in the files it will touch;
2. copies every file it will write or remove into a new backup folder, notes the bytes it is about
   to write in each, and puts a copy of its own upgrader there (the
   [recovery tool](#the-recovery-tool));
3. writes a lock file, `.memory-kit/upgrade.lock`;
4. writes the new files, removes the obsolete ones and replaces the kit section of `AGENTS.md`;
5. runs the data migrations;
6. writes `system/VERSION` and `system/kit.json` last, so an interrupted upgrade never looks
   finished.

A vault that lies in a folder another git repository does not track (for example inside a home
folder that a dotfiles repository covers) counts as not under git: step 1 is skipped, nothing is
written into that repository, and no git commands are printed at the end. A vault that is a
tracked folder of a bigger repository is checked in its own folder only.

### 4. Verify

Before it applies anything, `upgrade` runs your vault's current `check --lenient` and, when you
have golden questions, `eval`. After applying, it runs the new code:

- `check --generate --lenient` must not fail with an internal error;
- `start` must print a normal start view;
- `search` must work;
- hit@3 of the golden questions must not drop.

Before these run, the backup also takes what they may rewrite: the generated files, `.gitignore`
and every note that `check --generate` would normalize (CRLF line endings, a byte order mark, text
not in the NFC form). Such notes in a local root are saved inside that root, in
`<local root>/.memory-kit/backups/<id>/`, so private notes never enter the vault. The search log
is not part of the backup: `upgrade` removes the line of its own test search itself.

If any check fails, `upgrade` restores every file from the backup and exits 1 with the reason.
A file another program changed while the upgrade ran (a sync app, an editor) is restored too, but
only after its current version is saved under `conflicts/` in the backup, which then stays;
`upgrade` names these files. A file another program created meanwhile is left as it is and named
as well. New check findings that are only warnings do not stop the upgrade; they are listed for
you to look at. When every check passed, `upgrade` removes the lock and keeps the 5 newest
backups.

`--no-verify` skips this step, which is rarely a good idea. The generated views are then not
rebuilt either, so run `node system/memory.mjs check --generate` yourself afterwards; `upgrade`
reminds you.

## Which files change

Every kit file belongs to one group. The group decides what happens to it.

| group | paths | you did not change it | you changed it | it is missing |
|---|---|---|---|---|
| code | `system/memory.mjs`, `system/init.mjs`, `system/api.mjs`, `system/VERSION`, `system/lib/`, `system/lang/`, `system/templates/`, `system/schema/`, `system/migrations/`, `system/tools/`, `system/kit.json`, `system/kit-history.json` | replaced | the upgrade stops; `--force` replaces it (the backup keeps yours) | added |
| tests | `system/tests/**`, except `system/tests/golden.json` and the file `eval.golden` in `memory.json` names | replaced | as code | added, but only when your vault has `system/tests/helpers.mjs` |
| docs | `docs/**` | replaced | kept; the new version goes to `.memory-kit/upgrade/<version>/proposed/` | added, but only when your vault has a `docs/` folder |
| config | `.githooks/pre-commit`, `.github/workflows/ci.yml`, `.claude/settings.json`, `.agents/skills/memory/SKILL.md`, `.claude/skills/memory/SKILL.md`, `.claude/agents/memory-searcher.md`, `.gitattributes`, `GEMINI.md`, `install.sh`, `install.ps1` | replaced | kept; the new version goes to `.memory-kit/upgrade/<version>/proposed/` | skipped and reported; the pre-commit hook is always installed |
| block | `AGENTS.md`, from the line with `<!-- kit:start` to the line with `<!-- kit:end -->` | replaced by the kit section of the new kit, in your vault's language | replaced as well: the kit section belongs to the kit | missing or doubled markers, or a file saved as UTF-16: skipped and reported |
| never | `README*`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `memory.json`, `.gitignore`, all notes and hubs, the home page, `_ai/`, `.ignore`, `system/cleanup/`, `system/usage/`, golden files | untouched | untouched | untouched |

Your text in `AGENTS.md` before `<!-- kit:start` and after `<!-- kit:end -->` stays byte for
byte, also in a file that is not UTF-8 (a Windows code page, for example); the new kit section is
written as UTF-8. Keep your own rules in the `## Personal rules` section below the kit section,
and they survive every upgrade.

The generated files (`_ai/`, `.ignore`, the home page) are not copied. Verification rebuilds them
with `check --generate`, so they match the new code.

## When the upgrade stops

A **refusal** means the upgrade cannot work with this source. It exits 1 and changes nothing. The
most common ones:

| message starts with | what to do |
|---|---|
| `the source is damaged` | files of the downloaded kit do not match its `system/kit.json`; download it again |
| `… is not memory-kit 0.1.1 or newer` | the source is a kit older than 0.1.1, which has no `system/kit.json`; use a newer kit |
| `the source is inconsistent` | the new kit's `system/VERSION` and `system/kit.json` disagree; use another copy |
| `the vault has … and the source is older` | a downgrade; use `--rollback` to go back instead, or `--force` if you really mean it |
| `this kit upgrades vaults from version … on` | your vault is too old for this kit; upgrade to the named version first (`--ref`) |
| `the new kit needs Node.js …` | install a newer Node.js (the LTS version from nodejs.org) |
| `the data of this vault … is newer` | a newer kit already migrated this vault; use that kit |
| `memory.json cannot be read` | fix `memory.json` first; `node system/memory.mjs doctor` shows how. A vault made from 0.1.0 has no `doctor`: run the new kit's, `node <new-kit>/system/memory.mjs doctor --root <vault>` ([see below](#upgrading-a-vault-made-from-010)) |
| `the source is the vault itself` | `--from` points at your vault; point it at another copy of the kit |
| `an upgrade … is running right now (process …)` | another upgrade of this vault is still at work; wait until it finishes, then run the command again. `--force` does not override this |

Two more messages stop `upgrade` with exit 1 before there is a plan:
`kit.source is neither a git URL nor a folder` (fix `"kit": { "source" }` in `memory.json`, see
[Where the new kit comes from](#where-the-new-kit-comes-from)) and
`memory-kit could not be downloaded from …` (no network or a wrong URL; the next line says how to
use a copy of the kit you downloaded another way).

A **blocker** means the upgrade could run, but not yet. The plan lists every blocker:

| blocker | what to do |
|---|---|
| `<file>: changed here` | you changed a kit code or tests file; move your change elsewhere, or pass `--force` (the backup keeps your version) |
| `<file>: uncommitted changes` | commit first, then run `upgrade` again |
| `an earlier upgrade … did not finish` | undo it first with `node system/memory.mjs upgrade --rollback` ([An interrupted upgrade](#an-interrupted-upgrade)) |

Example of a plan with a blocker and a proposed file:

```text
memory-kit upgrade 0.1.1 → 0.1.2
kit files: 0 new, 3 updated, 0 removed, 226 unchanged
AGENTS.md: the kit section is replaced with system/templates/en/kit/agents-system.md; your text around it stays as it is
changed here, so kept; the new version goes to .memory-kit/upgrade/0.1.2/proposed for comparison:
  .claude/skills/memory/SKILL.md
the upgrade cannot run yet:
  system/lib/text.mjs: changed here; move your change elsewhere or use --force (the backup keeps your version)
```

## Backups, the lock and undo

`.memory-kit/` holds the local state of upgrades on this computer. It is never committed:
`upgrade` adds it to `.git/info/exclude`, and new vaults list it in `.gitignore`.

| path | content |
|---|---|
| `.memory-kit/backups/<YYYYMMDD-HHMMSS>-<from>-to-<to>/` | one backup per upgrade, named by its start time in UTC: `backup.json` (the list of files), `files/` (their bytes before the upgrade), `tool/` (the [recovery tool](#the-recovery-tool)) and, once a forced rollback saved your versions, `conflicts/`; the 5 newest are kept |
| `<local root>/.memory-kit/backups/<id>/` | notes of a local root that the checks may normalize, saved inside that root so they never enter the vault; removed together with the backup |
| `.memory-kit/upgrade/<to>/proposed/` | the new versions of config and docs files you changed |
| `.memory-kit/upgrade.lock` | exists while an upgrade runs: the backup, the versions, the process and the computer |
| `.memory-kit/backups/connect/`, `.memory-kit/backups/doctor/` | copies of the files `connect` and `doctor --fix` changed |

A backup holds every file the upgrade writes or removes, plus `AGENTS.md`, `memory.json` and the
files the checks may rewrite. For each file it also notes the bytes the upgrade is about to write,
before writing them. That is how a rollback tells the upgrade's own writes from your later edits,
even when the upgrade was interrupted half way.

### Undo an upgrade

```sh
node system/memory.mjs upgrade --rollback --dry-run
node system/memory.mjs upgrade --rollback
```

The first command shows what would be restored, and which files stand in the way. The second
restores the newest backup, or the one named by the lock of an interrupted upgrade. To restore an
older backup, name it: `upgrade --rollback 20260924-162948-0.1.1-to-0.1.2`. When the newest
backup was restored already, a plain `--rollback` says so and does nothing.

A rollback puts back what the upgrade changed, and nothing else:

- files the upgrade wrote get their old bytes back; files it added are removed, and so are the
  folders it created, when they are empty;
- temporary files that a killed write of the upgrade left next to them
  (`.<name>.tmp-<process>-<random>`) are removed;
- files the upgrade left as they were keep every later change: `memory.json`, which it only backs
  up, and the search log, which is not in the backup at all;
- the generated files (`_ai/`, `.ignore`, the home page) are put back without asking, because
  `check --generate` rebuilds them anyway;
- a note or `.gitignore` that the checks only normalized gets its old bytes back while its text
  is the same (for `.gitignore`: the lines outside the block the kit maintains);
- a note of a local root is put back only while its text is unchanged; one whose text changed
  since, or whose root or saved copy is gone, stays as it is (`skipped` in `--json`);
- the lock is removed.

**A file changed after the upgrade is a conflict.** It holds neither its old bytes nor what the
upgrade wrote, for example `AGENTS.md` after you added a personal rule. Then `--rollback` changes
nothing, lists the files and exits 1:

```text
these files changed after the upgrade, so nothing was restored; --force restores them anyway (their current version is saved in the backup):
  AGENTS.md
```

`--rollback --force` restores them anyway. The current version of each is first saved under
`conflicts/` in the backup folder, and the command says where:

```text
backup 20260924-162948-0.1.1-to-0.1.2 restored, the upgrade 0.1.1 → 0.1.2 is undone: 12 files restored, 0 removed
these files had changed after the upgrade; your version of each is saved under .memory-kit/backups/20260924-162948-0.1.1-to-0.1.2:
  AGENTS.md
```

A new file that the upgrade cannot prove it wrote counts as a conflict too, so a rollback never
removes it without a copy.

**The memory hooks for code projects go first.** They live in your user settings
(`~/.claude/settings.json`, `~/.codex/hooks.json`), outside the vault, and run
`system/memory.mjs hook …` in every repository you open. A kit older than 0.1.2 has no `hook`
command: its answer would be a hook error in every session, and a blocked Stop. So when the
rollback goes back to such a kit while those hooks run this vault, `upgrade --rollback` takes them
out first (as `connect claude-code --projects --remove` does) and says so; `--dry-run` names them.
The recovery tool cannot do that and refuses instead, naming the command to run first. After the
next upgrade, `connect claude-code --projects` puts them back.

### An interrupted upgrade

When the computer crashes or the terminal closes while an upgrade runs, the lock file stays. The
next `upgrade` stops with the blocker `an earlier upgrade … did not finish`, and `doctor` reports
it as `kit.upgrade_lock`. Undo it:

```sh
node system/memory.mjs upgrade --rollback
```

It restores the backup the lock names and removes the lock. The rules above hold here too: a file
you edited after the interruption makes `--rollback` refuse, and `--force` saves your version
first. When the vault's own commands fail with `internal error` (its code is half old, half new),
use the [recovery tool](#the-recovery-tool) instead; the line after the error names it.

If the backup of that upgrade is gone, there is nothing to restore: `upgrade --rollback --force`
only removes the lock (with `--dry-run` it only says it would).

**An upgrade that is still running** is not interrupted: its lock was refreshed on this computer
within the last six minutes (the upgrader refreshes it before every step), its process is still
alive, and that process runs `memory.mjs` (Linux reads this from `/proc`, macOS from `ps`,
Windows from PowerShell, because Windows hands out process ids again quickly). An upgrade that
stopped therefore counts as stopped after six minutes at the latest. Then `upgrade` refuses with
`an upgrade … is running right now (process …)`, and so does `--rollback`. `--force` overrides
neither, so a second terminal cannot undo files under a running upgrade. Wait until it finishes.
If something removes the lock anyway, the running upgrade does not report success: it ends with
`another command undid this upgrade while it ran, so it is not finished` and exit 1.

### The recovery tool

After an interruption the vault's code may be half old and half new, so its own commands may not
run. Every backup therefore carries a copy of the upgrader that made it, in `tool/`. It needs
nothing from the vault's code and works from any folder. In the vault folder:

```sh
node .memory-kit/backups/20260924-162948-0.1.1-to-0.1.2/tool/rollback.mjs --dry-run
node .memory-kit/backups/20260924-162948-0.1.1-to-0.1.2/tool/rollback.mjs
```

It restores its own backup by the same rules as `upgrade --rollback <id>`. `--dry-run` shows what
would change, `--force` restores changed files too (after saving them under `conflicts/`), and
`--json` prints `{ rollback: { ok, … } }`. Its messages are English only. Exit codes: 0 done, 1
refused (conflicts, an upgrade still runs, or memory hooks that the restored kit cannot serve), 2
an unknown option. The lock names the backup, so
`.memory-kit/upgrade.lock` tells you which folder to use.

When an upgrade stops before it finishes (the newer upgrader that took over was killed, or
restoring the backup failed too), `upgrade` prints this command for you, for example:

```text
memory: the upgrade stopped before it finished; undo it with: node .memory-kit/backups/20260924-162948-0.1.1-to-0.1.2/tool/rollback.mjs
```

## Data migrations

Two numbers describe the data format:

- `"version"` in `memory.json` is the data version of your vault;
- `data_version` in `system/kit.json` is the data version the kit's code reads.

When a new kit reads a newer data version, its migrations run during the upgrade. Each migration
moves the vault one step, for example from data version 1 to 2. It rewrites or moves files and
never deletes them, and the upgrade backs up every file a migration touches before the migration
writes. After the last step, `"version"` in `memory.json` is set to the new value.

A vault whose data is newer than the kit reads is refused. The kit code also refuses to run on it
and asks you to run `upgrade`.

0.1.1 ships no migration. Its data version is 1, the same as 0.1.0.

## Upgrading a vault made from 0.1.0

A vault made from 0.1.0 has no `upgrade` command yet. The new kit upgrades it once from outside.
Open a terminal in the folder that contains your vault (here `my-memory`) and run:

```sh
git clone --depth 1 https://github.com/8Krystof8/memory-kit.git memory-kit-new
node memory-kit-new/system/memory.mjs upgrade --root my-memory
node memory-kit-new/system/memory.mjs upgrade --root my-memory --yes
```

The second command shows the plan and changes nothing. In a terminal it then asks whether to apply
it; answer `y` and skip the third command. Without a terminal the third command applies it. Use the
English name `upgrade` here, even
in a Czech vault: the 0.1.0 language pack does not know `aktualizuj` yet, and for the same reason
this one run prints its messages in English.

If the plan says `memory.json cannot be read`, fix that file first. The 0.1.0 kit has no `doctor`,
so run the new kit's, which checks a vault from outside too:

```sh
node memory-kit-new/system/memory.mjs doctor --root my-memory
```

Its `config.memory_json` line says what is wrong and how to fix it. Where the 0.1.0 kit has no
command for a fix, its other lines name the new kit's, the upgrade itself for example.

Then commit in the vault:

```sh
cd my-memory
git add -A
git commit -m "memory-kit 0.1.0 → 0.1.1"
```

Finally delete the `memory-kit-new` folder. The backup in the vault carries its own
[recovery tool](#the-recovery-tool), so undoing the upgrade does not need that folder. From now on
`node system/memory.mjs upgrade` in the vault is enough.

Without git on this computer, download the kit as a ZIP from its GitHub page (Code → Download
ZIP), unzip it next to your vault and use that folder instead of `memory-kit-new`.

## Where the new kit comes from

`upgrade` takes the first of these:

1. `--from <folder or git URL>`;
2. `"kit": { "source": "…" }` in `memory.json`: a git URL, or a folder (absolute, or relative to
   the vault);
3. `source` in `system/kit.json` of your vault;
4. `https://github.com/8Krystof8/memory-kit.git`.

A git URL is cloned with `git clone --depth 1` into a temporary folder, which is deleted
afterwards. When a program still holds a file there and the folder cannot be deleted, `upgrade`
names it for you to delete later; the result of the upgrade stays as it is. `--ref <branch or tag>`
picks a branch or tag, for example `--ref v0.1.2`; with a folder, it clones that branch or tag from
the folder's git repository. A `kit.source` that is neither a git URL nor an existing folder stops
`upgrade` with `kit.source is neither a git URL nor a folder: …` (exit 1).

- **You use a fork of the kit:** put your fork's URL into `memory.json` once:

  ```json
  { "kit": { "source": "https://github.com/you/memory-kit.git" } }
  ```

- **No network:** copy a kit folder to the computer and pass it: `upgrade --from ../memory-kit`,
  or name it once in `memory.json`: `{ "kit": { "source": "../memory-kit" } }`.
- **The kit folder upgrades another vault:** `node <kit>/system/memory.mjs upgrade --root <vault>`
  uses that kit as the source. This is how a 0.1.0 vault is upgraded.

The upgrade itself needs no network. Only fetching a git URL does.

## All options

```text
node system/memory.mjs upgrade [--from <dir|git-url>] [--ref <branch|tag>] [--yes] [--dry-run]
                               [--force] [--rollback [backup-id]] [--no-verify] [--json]
```

| option | Czech alias | what it does |
|---|---|---|
| `--yes` | `--ano` | apply the plan without asking (without it, `upgrade` asks in a terminal and only prints the plan elsewhere) |
| `--dry-run` | `--nanecisto` | print the plan and change nothing, even with `--yes` |
| `--from <dir\|git-url>` | `--odkud` | take the new kit from this folder or git URL |
| `--ref <branch\|tag>` | | with a git URL, or a kit folder that is a git repository: clone this branch or tag |
| `--force` | `--vynutit` | replace files you changed, ignore uncommitted changes and the lock of an interrupted upgrade, allow a downgrade; with `--rollback`: restore files changed after the upgrade (your version is saved under `conflicts/` first), or remove a lock whose backup is gone. It never overrides an upgrade that is still running |
| `--rollback [id]` | `--vratit` | restore the newest backup (after an interrupted upgrade: its backup), or the named one |
| `--no-verify` | `--bez-overeni` | skip the checks before and after |
| `--json` | | print `{ runner, delegated_from, plan, result }` as JSON |

Exit codes: 0 done or up to date, 1 refused, blocked or failed (and rolled back), 2 a usage error,
3 an internal error.

## Version numbers

Versions are `MAJOR.MINOR.PATCH`, and `system/VERSION` holds the current one. While the major
number is 0:

- **Patch** (0.1.1 → 0.1.2): fixes and additions. The data version and the API version stay the
  same, so nothing you rely on changes.
- **Minor** (0.1.x → 0.2.0): may bring a data migration (`data_version` goes up) or a breaking
  change of the API (`api_version` goes up). The changelog says what changed and what to do.
- **1.0.0** comes when the vault format and the API have settled. From then on the usual semantic
  versioning rules apply.

`system/kit.json` also names `upgrade_from`, the oldest version this kit upgrades, and `node`, the
oldest Node.js it runs on. A vault older than `upgrade_from` is upgraded in steps: first with
`--ref` to a version in between, then to the newest.

## Releasing a new version (maintainers)

`upgrade` trusts `system/kit.json`. It refuses a kit whose files do not match it, and it replaces a
vault file only when that file's content is one a release shipped (`system/kit-history.json`). So
every release must update both files. The tool for this is `system/tools/release.mjs`:

```text
node system/tools/release.mjs                          rewrite kit.json and this version's history entry
node system/tools/release.mjs --check                  exit 1 when either is out of date (CI runs it)
node system/tools/release.mjs --import <git-ref> <version>
                                                       record the hashes of a past release from git
```

The checklist, in this order:

1. **Start the version.** Set `system/VERSION` to the new version, and the `<!-- kit:start vX.Y.Z`
   line in `AGENTS.md`, `system/templates/en/kit/agents-system.md` and
   `system/templates/cs/kit/agents-system.md`. Do this before the first `release.mjs` run of the
   new version; otherwise that run overwrites the history entry of the version already released.
2. **Change the kit.** After any change of a kit file, run `node system/tools/release.mjs`. The
   test `kit-manifest.test.mjs` fails while `system/kit.json` is stale.
3. **Migrations.** A change of the data format needs a migration in `system/migrations/index.mjs`
   (`{ id, from, to, title, run(ctx) }`) and a test that upgrades a vault through it.
   `data_version` in `kit.json` follows the highest `to` by itself.
4. **API.** A breaking change of `system/api.mjs` raises `API_VERSION` there; `api_version` in
   `kit.json` follows it. Additions keep the number ([api.md](api.md#stability-promise)).
5. **Changelog.** Move the "Unreleased" lines of [CHANGELOG.md](../CHANGELOG.md) into a section for
   the version with its date, and list the kit files that were added, changed or removed.
6. **Final checks** at the kit root, one at a time:

   ```sh
   node --test "system/tests/**/*.test.mjs"
   node system/tools/release.mjs --check
   node system/memory.mjs check --generate
   node system/memory.mjs check --strict
   ```

7. **Tag.** Commit, then tag the commit `v<version>` (for example `v0.1.2`) and push the tag, so
   `upgrade --ref v0.1.2` can fetch exactly this release.
8. **Try it.** Upgrade a copy of a vault made from the previous version, with `--from` pointing at
   the new kit, and check that `doctor` reports no failure afterwards.

After the tag, change nothing in the release. The next change starts the next version at step 1.
