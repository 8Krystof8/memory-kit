# Modes: github, local, combined

`init` asks for a mode once and writes it to `memory.json`. The mode decides where the notes live
and who can reach them. The note format, the CLI and the rules are the same in every mode.

| | **github** (default) | **local** | **combined** |
|---|---|---|---|
| main vault | a private GitHub repository | a git repository on one computer, no remote | a private GitHub repository |
| private folder for `local` sectors | optional | optional | yes (`--private-root`) |
| cloud agents (Claude Code on the web, Codex cloud, ChatGPT) | yes | no | yes, main vault only |
| on a phone ([phone.md](phone.md)) | yes: github.com, a git app or an agent | no (only with your own sync) | yes; the private folder stays off git |
| cloud sessions for setup | yes (without local sectors) | no: the vault would vanish with the container | no: the private folder would vanish; set up on your computer |
| CI (GitHub Actions) | nightly check and on manual runs | none | nightly check and on manual runs |
| best for | phone plus cloud agents | maximum privacy, one computer | phone and cloud agents for most things, some sectors never leave your devices |

"Private" always means the same thing: a sector with `privacy: local` keeps its content in a
separate folder outside the repository. The repository holds only the sector's manifest and an
optional export file. See [privacy.md](privacy.md).

## What init does in each mode

```sh
node system/init.mjs --mode github   --lang en --sectors core,work,school --yes
node system/init.mjs --mode local    --lang en --sectors core,work,health --private-root ../my-memory-private --yes
node system/init.mjs --mode github   --lang en --sectors core,work,family:github --yes   # family kept in the private GitHub repo
node system/init.mjs --mode combined --lang en --sectors core,work,school,health:local --private-root ../my-memory-private --yes
```

All modes do these steps: rename folders to the chosen language, write the hub files and the core
sector, create the chosen sectors from presets, write `memory.json`, generate the home page, `_ai/`,
`.ignore` and the `.gitignore` block for local sectors, run the strict check, and print the next
steps for your agents.

Guards:

- **github** has no private folder. A sector that is local by default (family, health, finances) is
  refused with a question: choose `--mode combined`, or write `family:github` to keep it in the
  private GitHub repository. Nothing private is created silently.
- **local** refuses a repository that already has a git remote (for example one made with "Use this
  template"): mode local promises that nothing leaves the computer. Remove the remote
  (`git remote remove origin`) or choose github or combined. `sync` never pushes in mode local.
- **Cloud sessions** (Claude Code on the web, Codex cloud, Codespaces): `init` refuses a private
  folder or mode local there, because the container and everything in it disappears when the
  session ends. Set up with mode github without local sectors, and add local sectors later on your
  own computer (see "github → combined" below). `--allow-ephemeral` exists only for throwaway tests.

Mode-specific steps:

- **github**: nothing extra. You commit and push the result.
- **local**: if the folder is not a git repository yet (a ZIP download), `init` runs
  `git init -b main`. There is no remote, so GitHub Actions never run.
- **combined**, or any mode with a `local` sector: `init` creates the private folder's skeleton
  (`sectors/<id>/` and `inbox/`, or their names in your language). It does not run `git init`
  there.

In every git repository, `init` sets `git config core.hooksPath .githooks`, so the pre-commit check
runs. `node system/memory.mjs start` sets it again when a fresh clone lacks it.

The default private folder is `../<repo-folder>-private`, next to the repository and never inside
it.

## memory.json per mode

```json
{ "mode": "github",
  "roots": [ { "id": "main", "path": ".", "privacy": "github" } ] }
```

```json
{ "mode": "combined",
  "roots": [ { "id": "main", "path": ".", "privacy": "github" },
             { "id": "private", "path": "../my-memory-private", "privacy": "local" } ] }
```

Only the keys that differ are shown. The first root is always `main`. A local root path is relative
to the repository, absolute, or starts with `~/`. `memory.json` is committed, so `init` never stores
an absolute path: a folder under your home folder is written as `~/…`, anything else relative to the
repository. Code uses the first root with `privacy: "local"`.
A local root has the same skeleton as the vault (`sectors/`, `inbox/`) but no manifests, no `_ai/`
and no `memory.json`. The manifests stay in the main vault, so every agent knows the sector exists.

Sectors are never listed in `memory.json`. The manifest `sectors/<id>/_<id>.md` is the only source
of truth about a sector.

## Choosing

- **You want to capture from your phone and use cloud agents:** github.
- **Some areas (health, family, money) must never reach GitHub or a cloud model:** combined. Mark
  those sectors `local` (`health:local`). Cloud agents see only what you put into the export file.
- **Nothing may leave your computer:** local. Remember that any cloud model you point at the
  folder still receives what it reads. Real privacy needs a local model (roadmap,
  [maintenance.md](maintenance.md#local-model-for-private-sectors)).
- **Unsure:** github. You can add a private folder later.

## The private folder

- **Backups.** The private folder is not in git by default, so back it up. Good options are an
  end-to-end encrypted sync service or an encrypted backup of the folder.
- **History (optional).** To keep a local git history without putting `.git` into a synced folder,
  keep the git directory outside it:

  ```sh
  git --git-dir="$HOME/.my-memory-private.git" --work-tree="$HOME/my-memory-private" init
  git --git-dir="$HOME/.my-memory-private.git" --work-tree="$HOME/my-memory-private" add -A
  git --git-dir="$HOME/.my-memory-private.git" --work-tree="$HOME/my-memory-private" commit -m "Snapshot"
  ```

  Never add a remote to it. A `.git` folder inside iCloud Drive, Dropbox or another sync folder can
  get corrupted.
- **Several computers.** Each computer needs its own copy of the private folder at the configured
  path. Where it is missing, `check` prints a `ROOT_MISSING` warning, and search simply does not show
  local results. The generated `_ai/` files do not depend on the private folder, so they are
  byte-identical on machines with and without it.
- **Phone.** Keep private notes on the phone in a separate folder that is not a git repository. See
  [phone.md](phone.md#private-sectors-on-the-phone).

## Changing the mode later

`init` runs only once. It refuses when `memory.json` says `"initialized": true`. Change the mode by
hand. `memory.json` is ordinary config, not a generated file.

**local → github or combined**

1. Create an empty **private** repository on GitHub.
2. `git remote add origin <url>` and `git push -u origin main`.
3. In `memory.json` set `"mode": "github"`, or `"combined"` if you have a local root.
4. `node system/memory.mjs check --generate`, then commit.

**github → combined (add a private folder)**

1. Create the folder, for example `../my-memory-private`, with an empty `sectors/` and `inbox/`
   (use your language's folder names).
2. Add the root to `memory.json`:
   `{ "id": "private", "path": "../my-memory-private", "privacy": "local" }`, and set
   `"mode": "combined"`.
3. Add private sectors with `node system/memory.mjs sector add <id> --privacy local`. Without a
   configured local root this command is refused on purpose.

**Moving an existing github sector to local** is a privacy operation, not a mode change. The
content is already in the git history. Follow
[privacy.md](privacy.md#when-something-private-reached-git) before you move anything.

## Offline and air-gapped use

Every command works without network access. Only `sync` talks to a remote; without a remote, or in
mode local, it prints that there is nothing to sync and exits 0. Search builds its index in memory on every run
and never writes it to disk.
