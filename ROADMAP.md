# Roadmap

memory-kit ships every weekend, on Saturday or Sunday. `main` only ever holds released versions:
the work happens on `dev`, and a release is a pull request from `dev` whose CI is green on Linux,
macOS and Windows. Merging it tags the version and publishes the GitHub Release. What each version
changes is in [CHANGELOG.md](CHANGELOG.md); how a memory gets it, in
[docs/upgrading.md](docs/upgrading.md). Dates are plans, not promises.

| weekend | version | theme |
|---|---|---|
| 3–4 October 2026 | 0.1.4 | Hardening: green CI everywhere, honest docs, updates that reach older memories |
| 7–8 November 2026 | 0.2.0 | Honest agents and the graph view, in a new repository |
| 14–15 November 2026 | 0.2.1 | Lightning search |
| 21–22 November 2026 | 0.2.2 | Cheap memory: fewer tokens at start, search and write |
| 28–29 November 2026 | 0.3.0 | Proof: a benchmark against Mem0 and the Claude Code auto memory |
| 5–6 December 2026 | 0.4.0 | Memory for developers: knowledge tied to the code |

0.1.5 never ships: the next version after 0.1.4 is 0.2.0.

## 0.1.4: hardening

- CI green on Linux, macOS and Windows with Node.js 22 and 24.
- One table of what each AI tool gets (the session start line, the 📎 line, activity, the project
  hooks), with every feature marked as measured or best-effort.
- `doctor` and `setup` print a ready GitHub link that adds the update workflow to a memory made
  before 0.1.3: the whole file fits into the link (about 5 KB; GitHub refuses links of 9 KB).
- `doctor` names the line to change in a `.claude/settings.json` that kept the old start hook.
- `SECURITY.md`, issue and pull request templates.

## 0.2.0: honest agents and the graph view

The agent no longer only promises to use the memory: the kit checks that it did.

- The 📎 line is checked at Stop: a cited note must exist and must have been opened in the
  session, a saved one must have changed. A wrong line goes back to the agent, at most 3 times.
- A decision or a correction the owner gave must be saved: when nothing was, the agent is asked
  once. Plan mode and subagents are left alone.
- One line for the owner after each answer that used the memory, at no token cost.
- An honesty score in `activity`: 📎 lines checked, right the first time, sent back, decisions
  asked to save.
- `connect --rules` writes the memory's rules into the global instructions of Claude Code, Codex
  and Gemini CLI; `connect --projects --everywhere` loads the memory in every folder.
- `start --project` and `memory_start {project}`: the owner or the agent picks the project to load
  instead of the general start.
- The source of a write over MCP is set by the kit, never by the caller.
- `node system/memory.mjs graph` (Czech `graf`): the memory as a live map in the browser.
- `llms.txt` and a one-prompt install.
- The new repository: same name, a new history, Apache-2.0.

## 0.2.1: lightning search

- The memory before the question: the kit attaches the 1–3 notes that fit each question, once
  search answers in milliseconds.
- The index stays loaded in the MCP server and changes only for the notes that changed: search in
  milliseconds instead of about 1.8 s at 5,000 notes.
- Trigram search for typos and every script, links between notes as a signal, and one merged list
  from all of them.
- The agent decides: a cheap search first, a deeper one when it asks.
- Search quality measured on every change: the misses written in `journal/` (`search_missed`)
  become the test set ("is the right note in the top 5?").

## 0.2.2: cheap memory

- A fixed start budget, also with thousands of notes.
- One-line writes: the kit fills in the template, date, file name, folder, links and checks.
- Compact search results without repeated fields.
- Everything that can be computed is computed by the kit, not by the model.

## 0.3.0: proof

- A benchmark in the repository: the same notes, questions and model for memory-kit, Mem0 and the
  Claude Code auto memory. It measures correct answers, facts that changed, "not in memory" when
  nothing is there, memory across sessions, tokens and time, graded blind and run three times.
- Published results, including where memory-kit loses. A pilot comes first.
- A measurement of the 📎 rule: runs with and without it show whether it pays for its tokens.

## 0.4.0: memory for developers

- Knowledge tied to files: when an agent opens a file, the kit attaches its gotchas and decisions.
- A note whose code changed is marked "check" instead of trusted.
- The dead-end guard: before an agent repeats an approach that already failed, it reads why.
- A living map of the project and a check of what the machine is missing to run it.
- The owner's seal: a rule counts only after the owner approved it; a changed rule is reported.
- The memory guard: deleting a note, rewriting a decision or saving a secret is stopped before it
  happens.

## Later

- Propose, validate, merge: agents propose a change, a deterministic validator checks it, and only
  then is it merged; the MCP server gets the same write path.
- Several writers: two agents or two computers changing the memory at the same time without losing
  a note.
- Time travel (the decision behind a line of code), memory per branch, reviews that propose rules,
  one memory for several repositories.
- Optional search by meaning with a small local model, computed in the background.
- Pairing a phone with a QR code, a connector for Claude and ChatGPT, autonomous maintenance.
- Import from other AI memories.
- The nightly cleanup, a local model for private sectors and a remote MCP server
  ([docs/maintenance.md](docs/maintenance.md#roadmap-not-built-yet)).
