# Roadmap

memory-kit ships every weekend, on Saturday or Sunday. `main` only ever holds released versions:
the work happens on `dev`, and a release is a pull request from `dev` whose CI is green on Linux,
macOS and Windows. Merging it tags the version and publishes the GitHub Release. What each version
changes is in [CHANGELOG.md](CHANGELOG.md); how a memory gets it, in
[docs/upgrading.md](docs/upgrading.md). Dates are plans, not promises.

| weekend | version | theme |
|---|---|---|
| 3–4 October 2026 | 0.1.4 | Hardening: green CI everywhere, honest docs, updates that reach older memories |
| 17–18 October 2026 | 0.1.5 | Proof: a benchmark against Mem0 and the Claude Code auto memory |
| 24–25 October 2026 | 0.2.0 | Writes: propose, validate, merge |
| 31 October – 1 November 2026 | 0.2.1 | Several writers at once |

## 0.1.4: hardening

- CI green on Linux, macOS and Windows with Node.js 22 and 24.
- One table of what each AI tool gets (the session start line, the 📎 line, activity, the project
  hooks), with every feature marked as measured or best-effort.
- `doctor` and `setup` print a ready GitHub link that adds the update workflow to a memory made
  before 0.1.3: the whole file fits into the link (about 5 KB; GitHub refuses links of 9 KB).
- `doctor` names the line to change in a `.claude/settings.json` that kept the old start hook.
- `SECURITY.md`, issue and pull request templates.

## 0.1.5: proof

- A benchmark in the repository: the same notes, questions and model for memory-kit, Mem0 and the
  Claude Code auto memory. It measures correct answers, facts that changed, "not in memory" when
  nothing is there, memory across sessions, tokens and time, graded blind and run three times.
- Published results, including where memory-kit loses. A pilot comes first.
- A measurement of the 📎 rule: runs with and without it show whether it pays for its tokens.

## 0.2.0: propose, validate, merge

- A design note first (the decisions of [docs/architecture.md](docs/architecture.md)).
- Agents propose a change instead of editing notes. A deterministic validator checks it (keys,
  links, secrets, budgets, the five laws), and only then is it merged.
- The MCP server gets the same write path, so apps can do more than add to the inbox.

## 0.2.1: several writers

- Two agents or two computers changing the memory at the same time: locks where they are needed,
  and merges that never lose a note.

## Later

- A live map of the memory: notes as dots, links as lines by their strength, growing while agents
  work. It needs a server on 127.0.0.1, an exception the network rules would have to allow.
- The nightly cleanup, a local model for private sectors, a remote MCP server and embeddings
  ([docs/maintenance.md](docs/maintenance.md#roadmap-not-built-yet)).
