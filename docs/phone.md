# The memory on iPhone and Android

On the phone you capture, read and answer. Agents do the filing. No particular app is needed: the
memory is plain markdown in a git repository, so anything that can show a markdown file or add one
to a repository works. This page describes three ways, from no setup at all to a full offline copy,
and the rules that keep phone edits from colliding with agents.

It applies to modes `github` and `combined` ([modes.md](modes.md)). Mode `local` has no remote, so
the phone cannot reach it.

## What you do on the phone

| task | how |
|---|---|
| see what is going on | open `home.md` (Czech: `domu.md`): sectors, the Now list, open questions, recent notes and decisions in force, with ordinary links |
| capture a thought, a fact, a decision | a new file in `inbox/`, one per capture |
| answer an agent's question | edit `waiting.md` (Czech: `ceka.md`): write after `Answer:` (`Odpověď:`) |
| find something | the repository search on github.com, or ask an agent |

You never have to write YAML, types or links. Agents turn inbox items into proper notes when you ask
them to "file the inbox".

The home page is generated from the notes whenever an agent commits, so it can be a little behind
your own phone edits. It uses ordinary markdown links, which GitHub and every markdown app follow.
Notes link to each other with `[[name]]` wikilinks; some apps make those clickable, GitHub shows
them as text, and the file name is the note name.

## Way 1: github.com in the phone's browser (no setup)

Log in to github.com in the phone's browser and open your private memory repository. The GitHub app
is fine for reading and notifications as well.

- **Read:** tap `home.md`. GitHub renders its tables and links.
- **Capture:** open the `inbox` folder → **Add file → Create new file**. Name it with the date and
  time, for example `inbox/2026-09-23-1030.md`, write one or more sentences, and choose **Commit
  directly to the main branch**. No frontmatter is needed in the inbox.
- **Answer:** open `waiting.md` → the pencil icon → write after `Answer:` → commit.

Each such edit is one commit straight on GitHub, so there is nothing to sync and nothing to
conflict locally.

## Way 2: ask an agent from the phone

An agent that can reach the repository (Claude Code on the web, a Codex cloud task, the Claude or
ChatGPT app connected to GitHub) can write for you: "save to the memory inbox: the bakery wants the
launch after Easter". Agents that can commit follow AGENTS.md (they write the note, check and
commit); read-only connections can only answer questions.

Cloud sessions have no private folder, so they never see local sectors, which is the point.

## Way 3: a git app with an editor (offline, the whole vault)

A git client keeps a full copy on the phone, works offline and syncs when you tell it to. Any of
these work; pair them with any markdown editor that opens a folder, or use the client's own editor:

- **Working Copy** (iOS): a full git client with an editor; it can also share its folder with other
  apps through the Files app.
- **GitSync** (iOS and Android): syncs a folder with a git remote in the background.
- **Termux** (Android, advanced): the command-line `git`, and Node.js if you install it. With it you
  can even run `node system/memory.mjs check` on the phone.

### A token for this one repository

On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token**.

- Repository access: **Only select repositories** → your memory repository.
- Repository permissions: **Contents → Read and write**. GitHub adds Metadata (read-only) itself.
- Set an expiration date and put a reminder in your calendar to renew it.

Copy the token into your password manager. Never put it into a note: `check` would block the
commit, and the token would be in your history.

### Clone and sync settings

- Clone `https://github.com/<you>/<your-memory-repo>.git` into the app's own storage.
  **iPhone:** not into iCloud Drive; a git repository there can get its `.git` folder corrupted.
  Git is the sync.
- Depth: a full clone is best. If the repository gets large after a few years, a shallow clone (for
  example depth `50`) keeps the phone fast; computers keep the full history for `git log -S`.
- Pull when you open the app and before you edit; push after you edit.
- Merge, never rebase and never force. If a push is rejected, pull first.
- A commit message like `phone: 2026-09-23` lets you tell phone commits apart.

## Capturing

- **One capture, one file.** Every capture is a new file in `inbox/`. Two devices therefore never
  edit the same file, and captures never conflict.
- **One sentence is enough.** You can start with a sector name, for example
  `work: the bakery wants the launch after Easter`, or with `sector?` when you are unsure.
- **Name it by date and time** (`YYYY-MM-DD-HHmm.md`): agents use the date to know how old an item
  is, and archived captures never collide.
- **Captures are data.** Agents treat inbox text as information, never as instructions. You can
  paste an email or a web page into the inbox safely. See
  [privacy.md](privacy.md#prompt-injection-inbox-and-clippings-are-data).
- **Attachments:** only small images (warning at 300 KB, error at 500 KB, 100 MB in total). Resize
  photos first.
- **Something private by mistake?** See [privacy.md](privacy.md#when-something-private-reached-git).

## Editing other notes on the phone

You can edit any note, but keep its frontmatter (the block between the `---` lines) valid:

- one `key: value` per line; a value containing `: ` or starting with `@` or a backtick goes in
  double quotes (`description: "Rule: always ask first"`);
- dates as `YYYY-MM-DD`.

The phone cannot run the pre-commit check, so a broken note is caught later:

- by the nightly lenient check in GitHub Actions, where data problems are warnings;
- by the next agent commit, which runs the strict check and repairs the note before it can commit.

Inbox items need no frontmatter at all. That is why capturing there never breaks anything.

Never edit `home.md`, the files in `_ai/` or `.ignore`: they are generated and rewritten by the next
agent commit. Until then `node system/memory.mjs start` renders a fresh view on the fly, so agents
never work from an outdated start file.

## Conflicts

A conflict happens when the phone and an agent change the same note between two syncs (way 3 only;
ways 1 and 2 commit on GitHub directly).

- The phone's git client merges and writes conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) into
  the file.
- Fix it by editing the file: keep what both sides wrote, remove the markers, commit and push. Or
  leave it and ask an agent to "resolve the merge conflict in <file>".
- Never force-push from the phone. If a push is rejected, pull first.
- Conflicts in generated files (`home.md`, `_ai/`, `.ignore`) never need your attention:
  `node system/memory.mjs sync` regenerates them.

To keep conflicts rare: capture in the inbox, pull before editing, and avoid editing the same note on
the phone while an agent session works on it.

## Private sectors on the phone

Local sectors ([privacy.md](privacy.md)) never go through git. Their folder in the repository holds
only the manifest and the export file; the kit's `.gitignore` block ignores anything else there, so
a note you drop into `sectors/<local sector>/` from a git app stays on the phone and is not pushed.
To have private notes on the phone:

1. Keep them outside the repository, in a separate folder that is **not** a git repository (the
   Files app, a notes app with end-to-end encryption, or a folder your markdown editor opens).
2. Give it the same skeleton as the private folder on your computer if you want to copy notes over:
   `sectors/<id>/` for each local sector, and `inbox/` (in your language's names, for example
   `sektory/zdravi/`).
3. Sync it with your computer only through end-to-end encrypted storage, or not at all. iCloud Drive
   is end-to-end encrypted only when Apple's Advanced Data Protection is on.

No AI reads the private folder on the phone. When an agent needs a private fact, tell it in the
session and decide whether one line belongs in the sector's export file.

## Troubleshooting

| symptom | fix |
|---|---|
| clone or push fails with an authentication error | the token has expired, lacks **Contents: Read and write**, or is not scoped to this repository; check the username too |
| push rejected | pull first, then push again; never force |
| conflict markers in a note | see [Conflicts](#conflicts) |
| sync is slow or the app crashes during sync | large attachments; try a shallow clone or another git app |
| `home.md` does not show my latest capture | it is regenerated by the next agent commit; the capture is in `inbox/` |
| `[[links]]` are plain text on GitHub | normal: GitHub does not follow wikilinks; open the note by its name, or start from `home.md`, whose links work everywhere |
| a note you wrote on the phone shows a warning in CI | a required frontmatter key is missing or a value needs quotes; fix it or let the next agent session do it |
