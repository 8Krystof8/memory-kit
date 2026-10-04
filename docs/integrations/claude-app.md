# The Claude app (claude.ai on the web, desktop and phone)

The Claude chat app is not Claude Code. On its own it cannot run commands or read your repository.
You have four ways to connect it today (the first three from the lightest to the most complete, the
fourth only in the desktop app), and a fifth is planned.

## 1. A profile in project instructions

Create a Claude project for the work where the memory matters. Paste `_ai/profile.md` into the
project instructions, without its first line (the `memory-kit v1 · …` header). The file is at most
1,500 characters: your profile's lead, the `github` sectors, and one sentence explaining that the
memory exists. See [chatgpt.md](chatgpt.md#1-a-profile-in-the-instructions) for what it looks like.

## 2. Files from GitHub in project knowledge

If your plan offers the GitHub integration for projects, add these files from the memory repository
to the project's knowledge:

- `_ai/start.md`: the sectors, hot notes, what is going on now, and the validity rules;
- `_ai/catalog.tsv`: one line per note, so Claude knows what exists and where;
- the sector index of the area you work on (`_ai/index-<sector>.md`), and the few notes you need.

Project knowledge is a snapshot. Sync it again after the memory changes. Answers from it are only as
fresh as the last sync. Never add files from local sectors: they are not in the repository anyway.

## 3. Claude Code from the app

The Claude app can start Claude Code sessions on the web, also from the phone. A session opened on
the memory repository gets the full integration: the SessionStart hook, the rules, search and
writing ([claude-code.md](claude-code.md)). Use this path when you want Claude to write to the
memory, file the inbox, or answer questions with citations.

If you run Claude Code on your own computer, its Remote Control feature (where available) lets you
drive that local session from the app. Files, including a private folder, stay on the computer.

## 4. Claude Desktop on your computer: the local MCP server

The Claude Desktop app can start the memory's MCP server on the same computer:
`node system/memory.mjs connect claude-desktop` adds it to `claude_desktop_config.json` (on Windows
also the Microsoft Store build's own copy of that file) and keeps your other servers. Quit Claude
Desktop completely (on Windows from the tray icon) and start it again; a new chat then lists
`memory-kit` among its tools. This works only in the desktop app, because the server runs on your
computer. More in [mcp.md](mcp.md).

## 5. Later: a remote MCP connector

Claude on the web and in the mobile apps reaches only remote MCP servers, from Anthropic's cloud,
so it cannot start the local server. A remote variant is on the roadmap
([maintenance.md](../maintenance.md#remote-mcp-server)): live, read-only search over the `github`
sectors and an inbox-only write tool through a custom connector, which works on the web, on desktop
and in the mobile app. It will require OAuth, never an unauthenticated URL.

## The app's own memory

The Claude app remembers context across chats and keeps a separate memory per project. That memory
is useful, but it is not the source of truth: it cannot be versioned, reviewed or searched by your
other agents. When something should last, capture it into the vault's `inbox/` (github.com, a git
app, [phone.md](../phone.md)), or ask a Claude Code session to write it.
