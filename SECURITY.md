# Security

memory-kit keeps your notes in a private repository, runs git and installs hooks into your AI
tools. A report about any of that is welcome.

## Reporting a vulnerability

Please do not open a public issue. Report it privately on GitHub:
[Security → Report a vulnerability](https://github.com/8Krystof8/memory-kit/security/advisories/new).
You get an answer within a week.

Helpful in a report: the version (`node system/memory.mjs --version`), your OS and Node.js
version, the AI tool, what you did and what happened, and whether a note, a key or a path could
leave the computer or reach git. Never paste your own notes or keys: a made-up example is enough.

## Supported versions

Only the newest release gets fixes. Releases come every weekend, and one command updates a
memory: `node system/memory.mjs upgrade` (it shows the plan first and keeps a backup).

## What memory-kit promises, and what checks it

| promise | checked by |
|---|---|
| it never goes online by itself: git reaches a remote only in `sync`, `upgrade` and the update check | [`system/tests/unit/network.test.mjs`](system/tests/unit/network.test.mjs), on every CI run |
| keys and passwords never enter a note | `check` (rule `SECRET`) in the pre-commit hook and in CI; the MCP inbox refuses them |
| notes of a local sector never reach git | `check` (rule `LOCAL_IN_GIT`), [docs/privacy.md](docs/privacy.md) |
| `.memory-kit/` (logs, backups) is never committed | `.gitignore`, `.git/info/exclude` in older clones, `doctor` (`git.repo`) |
| an upgrade never overwrites your notes and can be undone | [docs/upgrading.md](docs/upgrading.md) and the upgrade tests |
| the MCP server reads only notes of the vault | path checks in `system/api.mjs` and the MCP tests |
