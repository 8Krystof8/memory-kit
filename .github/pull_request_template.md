## What and why

<!-- One topic per pull request. Pull requests go to `dev`; `main` only gets releases. -->

## Checklist

- [ ] `node --test "system/tests/**/*.test.mjs"` passes
- [ ] `node system/memory.mjs check --strict` passes on the kit root
- [ ] `node system/tools/release.mjs` was run, so `--check` passes
- [ ] the contract (`docs/architecture.md`) and the docs are updated when behavior changed
- [ ] a line in `CHANGELOG.md` under the version in progress
- [ ] no private data, no literal secrets, no new dependencies
