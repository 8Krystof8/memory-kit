# Gemini CLI

Gemini CLI loads `GEMINI.md` files as context. The kit's `GEMINI.md` is a single line:

```markdown
@AGENTS.md
```

Gemini CLI resolves `@file` imports, so it gets exactly the same rules as every other agent. `check`
verifies that the import is the first non-empty line (`ADAPTER_IMPORT`).

Do not also set `context.fileName` to `AGENTS.md` in `.gemini/settings.json`. Gemini would then
load the rules twice.

## Setup

Gemini CLI has no hook in the kit that loads the start file, and it needs none: the system section
of `AGENTS.md` (imported by `GEMINI.md`) tells it to run `node system/memory.mjs start` first when
"Memory: start" is not in its context yet.

Gemini runs it through its shell tool. Approve `node system/memory.mjs …` when asked.

If your Gemini CLI version supports Agent Skills from `.agents/skills/`, it also finds the kit's
`memory` skill. `GEMINI.md` alone is enough.

## Things to know

- **Its own search tools may not read `.ignore`.** Gemini's grep and glob tools respect
  `.gitignore` and `.geminiignore`. Depending on the version and settings, they may ignore
  ripgrep's `.ignore`, and then archived notes and sleeping sectors appear in their results. Rule 6 of the search protocol still applies: status `active`
  and the newer `updated` win, and `replaced_by` leads to the valid version. Prefer
  `node system/memory.mjs search`, which ranks and filters. Adding `archive/` to a `.geminiignore`
  would hide the archive from all of Gemini's file tools, so the kit does not do it.
- **`save_memory` is not the memory.** Gemini CLI's memory tool appends facts to a global
  `GEMINI.md` in your home folder, which travels nowhere. For anything that should last, "remember
  this" means a note in this repository. If Gemini reaches for `save_memory`, add a personal rule:
  `"Remember" always means writing to this repository, never save_memory.`
- **Broad questions:** there is no subagent. Gemini follows the limits of the protocol itself: at
  most three searches with different stems, headers first, at most two whole files.
- **Commits** go through the pre-commit hook like everyone else's.

## Gemini in the browser or the app

The Gemini app cannot read your files and has no memory API. Paste `_ai/profile.md` into its
personal instructions ("Instructions for Gemini"), and read [chatgpt.md](chatgpt.md) for the
limits of that approach. It works the same way.
