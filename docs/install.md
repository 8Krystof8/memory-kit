# Installing memory-kit

One line in a terminal installs the kit and sets up a private memory.

| system | command |
|---|---|
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.sh \| sh` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1 \| iex` |

With options: `… | sh -s -- --dir ~/pamet --lang cs` on macOS and Linux, and
`& ([scriptblock]::Create((irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1))) -Dir C:\pamet -Lang cs`
in PowerShell.

## What the installer does

1. Checks for git and Node.js 22.5 or newer. If one is missing it prints the install command for
   your system (Homebrew, apt, dnf, fnm or winget) and stops. It never installs anything itself and
   never uses sudo.
2. Asks where the memory lives (github, local or combined) and in which folder (default `~/memory`).
3. Creates the memory:
   - with the GitHub CLI (`gh`) logged in and mode github: a new **private** repository from the
     template, cloned into the folder;
   - otherwise: the kit is downloaded without its history into a fresh git repository with no remote,
     so your notes can never be pushed to the public kit repository.
4. Runs the setup wizard (`node system/init.mjs`): language, sectors, AI tools, then optional extras
   (connect apps, memory for coding projects, a health check).

Run on a folder that already holds a memory, it offers `doctor` and `upgrade` instead of setting
anything up again.

## Options

| sh | PowerShell | environment variable | meaning |
|---|---|---|---|
| `--dir <path>` | `-Dir` | `MEMORY_KIT_DIR` | memory folder (default `~/memory`) |
| `--yes` | `-Yes` | `MEMORY_KIT_YES=1` | ask nothing |
| `--no-gh` | `-NoGh` | `MEMORY_KIT_NO_GH=1` | never use the GitHub CLI |
| `--source <url\|dir>` | `-Source` | `MEMORY_KIT_SOURCE` | kit repository or a local kit folder |
| `--ref <tag\|branch>` | `-Ref` | `MEMORY_KIT_REF` | kit version (default: the newest `v*` tag) |
| `--mode` | `-Mode` | `MEMORY_KIT_MODE` | github, local or combined |
| `--lang` | `-Lang` | `MEMORY_KIT_LANG` | en or cs |
| `--sectors` | `-Sectors` | `MEMORY_KIT_SECTORS` | for example `core,work` |

## Refusals

The installer stops (exit 3) when it runs as root or in an administrator shell, when the folder
lies inside another git repository that does not ignore it (allow with `MEMORY_KIT_ALLOW_NESTED=1`),
or when the folder's GitHub remote is public. Exit codes: 0 done, 1 a step failed, 2 usage or a
missing prerequisite, 3 refused, 130 cancelled.

## The setup wizard later

`node system/memory.mjs setup` (Czech: `nastaveni`) opens the extras menu again in a set-up memory.
Without a terminal, `init` and `setup` keep their plain, scriptable behaviour.

## Uninstall

Run `node system/memory.mjs connect claude-code --projects --remove` (and the same for `codex`) if
you switched on memory for coding projects, then delete the memory folder and its `-private`
folder.
