# ChatGPT

ChatGPT on the web cannot run the CLI, but it can read the repository through its GitHub
connector. It can also know who you are from a short profile you paste into its instructions. It
cannot write to the memory. The ChatGPT desktop app can do more: it starts the memory's MCP server
on your computer ([the desktop app](#the-chatgpt-desktop-app-the-local-mcp-server)).

## 1. A profile in the instructions

`_ai/profile.md` is generated for this. It holds the lead of your profile note, the `github`
sectors with one line each, and one sentence explaining that a memory exists. It is at most 1,500
characters:

```text
# Profile
I run Linden Studio, a two-person design studio, and I study at Northfield School.
Answer briefly and name the file you used.
Plain language, no marketing words.
Sectors: core (You and the system: …); school (The thesis at Northfield School, …); work (Linden Studio: clients, …)
I keep a long-term memory in a private git repository of markdown notes. When I ask about my projects or decisions, ask me for the file path or search it.
```

Paste everything after the first line (the `memory-kit v1 · …` header) into ChatGPT's custom
instructions, or into the instructions of a ChatGPT project. The profile comes from the lead lines
of your profile note (`sectors/core/profile.md`) and the sector manifests. Edit those, not the
generated file, and paste again after big changes. Read it before pasting: it is meant to be
harmless, but you decide what a chat app knows.

## 2. Reading the repository through GitHub

Connect GitHub in ChatGPT's settings (Apps or Connectors, depending on the version) and allow it to
access your memory repository. The connection is read-only.

Know the connector's limits:

- It reads only the default branch.
- It skips large files (over about 350 KiB). Notes are far below that.
- Its code search truncates lines longer than 1,024 characters. That is why catalog rows stay under
  600 characters and note lines under 1,000.
- Its search is literal: it does not know that `portálu` and `portál` are the same word. The catalog
  and the `keywords` field compensate: they carry stems without accents and common word forms.

Ask with paths. The repository is built so that paths and first lines tell what is where:

- "In the repository `<you>/<memory>`, read `_ai/start.md`. Then answer: what did we decide about
  pricing?"
- "Search `_ai/catalog.tsv` in `<you>/<memory>` for `packag` and open the matching decision notes."
- "Read `sectors/work/_work.md` and `_ai/index-work.md`, then summarize open projects."

Validity rules apply here too. Tell ChatGPT to trust only `status: active` and the newer `updated`,
and to follow `replaced_by`. They are in `_ai/start.md`, so asking it to read that first is enough.

## 3. ChatGPT's own memory

ChatGPT's memory changes in the background, has no export, and does not keep every detail. Treat it
as a convenience, not a source. When something should last, put it into the vault.

## Writing from ChatGPT

ChatGPT on the web has no write path into the memory. The simple workflow:

1. Ask ChatGPT to draft a one-paragraph capture ("write this as a note for my inbox").
2. Save it as a new file in `inbox/`, for example on github.com (**Add file → Create new file**,
   `inbox/2026-09-23-1030.md`) or in any git app ([phone.md](../phone.md)).
3. The next agent session files it when you ask it to "file the inbox".

A remote server with `search` and `fetch` in the shape ChatGPT expects is on the roadmap
([maintenance.md](../maintenance.md#remote-mcp-server)). Whether your ChatGPT plan allows custom
connectors with write access varies. Check before relying on it.

## The ChatGPT desktop app: the local MCP server

The ChatGPT desktop app shares its MCP settings with Codex. One command in the vault gives it the
memory's MCP server, with search, read and a tool that saves new captures to the inbox:

```sh
node system/memory.mjs connect codex
```

Restart the app, then ask it to call `memory_start`. With `--read-only` it gets no write tool. This
works only in the desktop app, because the server runs on your computer. More in [mcp.md](mcp.md).

## Privacy

The connector reads the whole repository. Git has no per-folder permissions. Everything in
`github` sectors is visible to ChatGPT once it is connected. Local sectors are not in the
repository, so ChatGPT never sees them. See [privacy.md](../privacy.md).
