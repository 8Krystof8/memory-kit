# MCP: the memory in AI apps

Many AI apps can start small helper programs called MCP servers. The memory has one built in. Once
an app knows about it, the app's AI can search your notes, read them and save new captures to the
inbox, in any project and any chat, without you copying anything.

`connect` adds the server to an app's settings in one command. This page lists the apps, where
their settings live, what to do after connecting, and what to do when something does not work.

## Contents

- [Connect an app in three steps](#connect-an-app-in-three-steps)
- [Apps and commands](#apps-and-commands)
- [Where the settings live](#where-the-settings-live)
- [Apps that cannot start a local server](#apps-that-cannot-start-a-local-server)
- [All options](#all-options)
- [What connect writes](#what-connect-writes)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)

## Connect an app in three steps

Run these in your vault folder. The examples use Cursor.

1. See which apps this computer has:

   ```sh
   node system/memory.mjs connect --list
   ```

   One row per app, shortened here:

   ```text
   MCP clients for /home/you/my-memory:
     claude-code     not connected  Claude Code · /home/you/.claude.json
     claude-desktop  app not found  Claude Desktop · /home/you/.config/Claude/claude_desktop_config.json
     cursor          not connected  Cursor · /home/you/.cursor/mcp.json
     …
     chatgpt         guidance only  ChatGPT · –
   connect one with: node system/memory.mjs connect <client>
   ```

2. Connect one:

   ```sh
   node system/memory.mjs connect cursor
   ```

   It prints what it changed and what to do next:

   ```text
   Cursor: added "memory-kit" to /home/you/.cursor/mcp.json
   this is a new file; to undo, delete it
   next: restart Cursor and allow memory-kit when it asks
   check: Cursor Settings > MCP lists memory-kit with its tools
   then ask the agent to call memory_start; it answers with the start page of your memory
   ```

3. Restart the app, allow the server when it asks, and ask its AI: "call memory_start".

The app then has five tools:

| tool | what it does |
|---|---|
| `memory_start` | the start page of your memory: sectors, recent notes, what is going on now, and the search rules for these tools |
| `memory_search` | full-text search, the same as `node system/memory.mjs search` |
| `memory_read` | reads one note, a page of lines at a time (a very long line in pieces, with `column`) |
| `memory_recent` | notes changed in the last days |
| `memory_inbox` | saves a new capture to `inbox/`; it never changes existing notes |

Details about each tool are in [api.md](../api.md#the-mcp-server).

`connect` needs to run once per app and computer. The settings point at the vault folder on this
computer, so on another computer run it there too.

## Apps and commands

| app | command | after connecting | how to check |
|---|---|---|---|
| Claude Code | `connect claude-code` | start a new session (running sessions keep their old servers) | `claude mcp get memory-kit`, or `/mcp` in a session |
| Claude Desktop | `connect claude-desktop` | quit it completely (on Windows from the tray icon) and start it again | a new chat lists memory-kit among its tools |
| Cursor | `connect cursor` | restart Cursor and allow the server | Cursor Settings > MCP lists memory-kit |
| VS Code (Copilot agent mode) | `connect vscode` | no restart: it starts the server with the next chat message and asks you to trust it | run MCP: List Servers from the command palette |
| Windsurf (Devin Desktop) | `connect windsurf` | restart it and allow the server | the MCP servers panel lists memory-kit |
| Gemini CLI | `connect gemini-cli` | start `gemini` again (or `/mcp reload`) and trust the folder; in untrusted folders it starts no MCP servers | `/mcp list` shows memory-kit as connected |
| Codex (CLI, IDE extension, ChatGPT desktop app) | `connect codex` | restart it | `codex mcp list`, or `/mcp` in a session |
| Zed | `connect zed` | no restart | the Agent panel settings list memory-kit |
| LM Studio | `connect lm-studio` | restart it and allow the tool calls | Program > Install > Edit mcp.json shows memory-kit |
| Cline | `connect cline` | reload the extension or restart the IDE | MCP Servers > Installed lists memory-kit |
| GitHub Copilot CLI | `connect copilot-cli` | start `copilot` again and allow the tool calls | `/mcp` lists memory-kit |
| Junie | `connect junie` | restart the IDE or `junie` | the MCP settings of Junie list memory-kit |
| JetBrains AI Assistant | `connect jetbrains` | prints the entry to paste (see below) | the IDE's MCP settings list memory-kit |
| ChatGPT desktop app | `connect codex` | it shares its settings with Codex | as Codex |

Every command starts with `node system/memory.mjs`, for example
`node system/memory.mjs connect claude-desktop`. In Czech, `pripoj` means `connect`.

Claude Code, Codex, Gemini CLI and Cursor also read the memory without MCP when you work inside
the vault: `AGENTS.md` tells them to run `node system/memory.mjs start`. MCP adds the memory to
every other project and to apps that cannot run commands.

## Where the settings live

`connect` finds the file by itself. You need this table only to look at the file or to fix it by
hand. `~` is your home folder; on Windows `%APPDATA%` is `C:\Users\<you>\AppData\Roaming`.

| app | Windows | macOS | Linux |
|---|---|---|---|
| Claude Code | `~\.claude.json` | `~/.claude.json` | `~/.claude.json` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~\.cursor\mcp.json` | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` |
| VS Code | `%APPDATA%\Code\User\mcp.json` | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` |
| Windsurf (Devin Desktop) | `%APPDATA%\devin\mcp_config.json` and `~\.codeium\windsurf\mcp_config.json` | `~/.config/devin/mcp_config.json` and `~/.codeium/windsurf/mcp_config.json` | the same as macOS |
| Gemini CLI | `~\.gemini\settings.json` | `~/.gemini/settings.json` | `~/.gemini/settings.json` |
| Codex | `~\.codex\config.toml` | `~/.codex/config.toml` | `~/.codex/config.toml` |
| Zed | `%APPDATA%\Zed\settings.json` | `~/.config/zed/settings.json` | `~/.config/zed/settings.json` |
| LM Studio | `~\.lmstudio\mcp.json` (or `~\.cache\lm-studio\mcp.json`) | `~/.lmstudio/mcp.json` (or `~/.cache/lm-studio/mcp.json`) | the same as macOS |
| Cline | `~\.cline\data\settings\cline_mcp_settings.json` | `~/.cline/data/settings/cline_mcp_settings.json` | the same as macOS |
| GitHub Copilot CLI | `~\.copilot\mcp-config.json` | `~/.copilot/mcp-config.json` | `~/.copilot/mcp-config.json` |
| Junie | `~\.junie\mcp\mcp.json` | `~/.junie/mcp/mcp.json` | `~/.junie/mcp/mcp.json` |

More details:

- **Environment variables** that move a folder are respected: `CLAUDE_CONFIG_DIR` (Claude Code),
  `CODEX_HOME` (Codex), `GEMINI_CLI_HOME` (Gemini CLI), `COPILOT_HOME` (Copilot CLI),
  `CLINE_DIR`, `CLINE_DATA_DIR` and `CLINE_MCP_SETTINGS_PATH` (Cline), `XDG_CONFIG_HOME` on Linux.
- **Claude Code** is connected through its own command,
  `claude mcp add --scope user --transport stdio memory-kit -- …`, when `claude` is installed.
  Otherwise `connect` writes the user entry into `~/.claude.json` itself.
- **Claude Desktop from the Microsoft Store** keeps a private copy of its settings under
  `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\`. When that copy exists, `connect`
  edits it, because that is the file the app reads.
- **VS Code Insiders** is used when only Insiders is installed. Only the default profile is edited.
- **Windsurf** was renamed to Devin Desktop. When both settings files exist, both get the entry.
  When one is a link to the other, it is one file and is edited once.
- **LM Studio** may keep its folder elsewhere (`~/.lmstudio-home-pointer` says where); `connect`
  follows that pointer.
- **Cline**: older versions of the extension kept the file in VS Code's storage;
  `connect` uses that file only when it is the only one.

## Apps that cannot start a local server

Some apps run in the cloud and cannot start a program on your computer. `connect` prints what to
do instead and exits 0:

- **ChatGPT on the web** reads the memory through its GitHub connector, and a profile in its
  instructions tells it who you are ([chatgpt.md](chatgpt.md)). The ChatGPT desktop app is different:
  it uses the Codex settings, so `connect codex` gives it the memory.
- **Claude on the web and in the mobile apps** reaches only remote MCP servers, from Anthropic's
  cloud. Use the GitHub integration, a profile in a project, or a Claude Code session
  ([claude-app.md](claude-app.md)). For the Claude Desktop app on your computer, use
  `connect claude-desktop`.
- **JetBrains AI Assistant** keeps its MCP servers in the IDE settings, not in a file. `connect
  jetbrains` prints the JSON to paste into Settings | Tools | AI Assistant | Model Context Protocol
  (MCP). For Junie, use `connect junie`.

A remote server for these apps is on the roadmap
([maintenance.md](../maintenance.md#remote-mcp-server)).

## All options

```text
node system/memory.mjs connect <app> [--scope user|project] [--name memory-kit] [--read-only]
                                     [--dry-run] [--remove] [--force] [--json]
node system/memory.mjs connect --list [--json]
```

| option | Czech alias | what it does |
|---|---|---|
| `--list` | `--seznam` | one row per app: connected, not connected, app not found, guidance only, unreadable |
| `--dry-run` | `--nanecisto` | show what would change and change nothing |
| `--remove` | `--odebrat` | take the entry out again |
| `--read-only` | `--jen-cteni` | a server without `memory_inbox`: the app can only read |
| `--name <name>` | `--jmeno` | the entry's name in the app (default `memory-kit`); useful for a second vault |
| `--scope project` | `--rozsah` | Cursor and VS Code only: write a portable entry into the vault's own `.cursor/mcp.json` or `.vscode/mcp.json` instead of your user settings |
| `--force` | `--vynutit` | replace another entry with the same name, or write the file for an app that is not installed yet |
| `--json` | | print the result as JSON |

Examples, one command at a time:

```sh
node system/memory.mjs connect claude-desktop --dry-run
node system/memory.mjs connect vscode --read-only
node system/memory.mjs connect cursor --remove
```

Two vaults in one app: connect the second one with another name, for example
`node system/memory.mjs connect cursor --name memory-work` in the second vault.

## What connect writes

For a JSON settings file, one entry under the app's list of servers:

```json
"memory-kit": {
  "type": "stdio",
  "command": "/usr/local/bin/node",
  "args": [
    "/home/you/my-memory/system/memory.mjs",
    "mcp",
    "--root",
    "/home/you/my-memory"
  ]
}
```

For Codex, a table at the end of `config.toml`:

```toml
[mcp_servers.memory-kit]
command = "/usr/local/bin/node"
args = ["/home/you/my-memory/system/memory.mjs", "mcp", "--root", "/home/you/my-memory"]
```

- The command is the full path of the Node.js that ran `connect`, so apps started from the Dock,
  the Start menu or a desktop icon find it without your shell's `PATH`. A Homebrew path that
  changes with every upgrade is replaced by a stable Homebrew link such as `/opt/homebrew/bin/node`.
- The key and the fields follow each app's format: `servers` for VS Code, `context_servers` for
  Zed, `mcpServers` for most others; `"type": "stdio"` only where the app expects it.
- Every other server and setting in the file stays as it was, and so do the file's indentation
  and line endings. Fields you add to the entry yourself (`env`, `timeout`, `disabled`, `tools`)
  survive when `connect` updates it.
- A settings file that is a symbolic link (from a dotfiles repository, for example) stays a link:
  `connect` edits the file it leads to, or creates it there when that file does not exist yet. A
  link into a folder that does not exist is refused, so no folders appear at a stale target.
- Before a file changes, `connect` copies it to `.memory-kit/backups/connect/` in the vault. That
  folder is never committed. The backups may hold other servers' keys, so on macOS and Linux they
  are readable only by you.
- An entry counts as the memory's when its arguments name this vault's `memory.mjs`. Running
  `connect` again updates it in place; it never adds a second copy.

## Privacy

- Notes of local sectors never leave the server. `connect` never adds `--local`. A note left in a
  local sector's folder of the vault itself (which `check` reports as `LOCAL_IN_GIT`) stays out of
  search results, the start view and `memory_read` too, even with `--local`; the start view's
  alert names only its path.
- The app's AI can read every note of your shared sectors, like any agent in the vault. What it
  reads goes to that app's model provider ([privacy.md](../privacy.md#model-providers)).
- `memory_inbox` can only add new files to `inbox/`. It refuses text that looks like a key or
  password. Connect with `--read-only` when an app should not write at all.
- `memory_read` opens only notes. Kit code, `.git/`, hidden folders and paths outside the vault are
  refused in code, whatever the app sends.

## Troubleshooting

Start with `node system/memory.mjs doctor`. Its `mcp.clients` line lists the apps connected to this
vault and warns about entries that no longer work.

| symptom | cause and fix |
|---|---|
| the app shows no memory tools | most apps read their settings only at start: quit the app completely and start it again (Claude Desktop on Windows: quit from the tray icon, closing the window is not enough); some apps also ask you to allow or trust the server first |
| `connect` says the app was not found | its settings folder does not exist yet: install the app and start it once, then connect again; `--force` writes the file anyway |
| `connect` prints an entry to paste and exits 1 | the settings file contains comments (JSONC; common in Zed and Gemini CLI settings), is not valid JSON, holds numbers too large to write back exactly, or cannot be read (it belongs to another user, for example); `connect` never rewrites such a file. Paste the printed entry where it says, then save. With `--remove` it says what to delete yourself, or that the file must be fixed first |
| `connect` says a file `is a link to …, whose folder does not exist` | the settings file is a symbolic link into a folder that is missing (a dotfiles folder not set up on this computer); create that folder or remove the link, then connect again |
| `connect` reports a conflict | another entry with the same name starts something else; pick another name with `--name`, or replace it with `--force` |
| the entry disappeared again | Claude Desktop and Claude Code rewrite their settings while they run and may drop an edit made meanwhile: quit the app, run `connect` again, then start the app |
| the server does not start: "command not found" or "spawn node ENOENT" | the app cannot find Node.js. `connect` writes the full path of the Node.js that ran it; after Node.js moved (a Homebrew or nvm upgrade, a new install), run `connect` again. `doctor` warns when an entry's command no longer exists |
| Claude Desktop from the Microsoft Store ignores the entry | it reads its private copy of the settings; run `connect claude-desktop` again after starting the app once, so `connect` finds that copy. Its Edit Config button may open the other file |
| Claude Desktop shows a server error | read `mcp-server-memory-kit.log` in its log folder: `~/Library/Logs/Claude/` on macOS, `%APPDATA%\Claude\logs\` on Windows |
| Gemini CLI lists no tools | the folder is not trusted; Gemini CLI starts no MCP servers in untrusted folders |
| `could not be written … close … and run the command again` | on Windows the app holds the file open; close the app and run `connect` again |
| every tool call answers with a config error | `memory.json` of the vault is broken; the server keeps running and reports it. `node system/memory.mjs doctor` shows how to fix it |
| you moved or renamed the vault folder | the entry still points at the old folder, so `connect` in the new place reports a conflict: run it with `--force` to replace the old entry |
