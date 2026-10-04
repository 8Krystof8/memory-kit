// Data migrations of memory-kit. The data version is memory.json "version"; system/kit.json
// data_version is the version this kit's code reads. Each entry moves a vault one step and runs
// only inside `upgrade`, which backs up every file a migration writes or moves first:
//
//   { id: '0002-rename-x', from: 1, to: 2, title: 'what changes, in one line', run(ctx) { ... } }
//
// ctx = { root, lang, readText, writeText, readJson, writeJson, move, log }, all with POSIX paths
// relative to the vault root (system/lib/migrations.mjs). A migration never deletes user data: it
// rewrites or moves. The list is ordered; upgrade sets memory.json "version" after each step.

export const MIGRATIONS = [];
