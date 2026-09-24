// `check`: validates the vault; with --generate it first normalizes notes (LF, NFC, no BOM) and
// rewrites the generated files (docs/architecture.md, 10.3). --pre-commit is what the git hook runs.
// Exit 1 when there are errors.

import fs from 'node:fs';
import path from 'node:path';
import { formatFindings, runChecks } from '../check.mjs';
import { writeGenerated } from '../generate.mjs';
import { loadVault } from '../vault.mjs';
import { checkToday, git, isGitRepo, parseCli, replaceFile, usageError } from '../util.mjs';

export const usage = 'check [--generate] [--strict|--lenient] [--today YYYY-MM-DD] [--json] [--pre-commit]';

/**
 * Rewrites notes with CRLF line ends, a BOM or text that is not NFC. None of this changes what a
 * note says: git stores LF anyway, and NFC only merges combining accents into one character, which
 * rg and every grep then find. The rewrite is atomic (an interrupted run never leaves half a
 * note) and lands on the note's own file (note.path). Returns the rewritten notes as [{root, rel}].
 */
export function normalizeNotes(vault) {
  const out = [];
  for (const n of vault.notes) {
    if (!n.crlf && !n.bom && n.nfc) continue;
    try {
      // A replace by rename would pass a read-only note; the owner made it read-only on purpose.
      fs.accessSync(n.path, fs.constants.W_OK);
      replaceFile(n.path, n.text.normalize('NFC'));
      out.push({ root: n.root, rel: n.rel });
    } catch {
      /* read-only file: check still reports it */
    }
  }
  return out;
}

const splitZ = (s) => s.split('\0').filter(Boolean);

/**
 * The check reads the work tree, so a commit is only safe when every staged file equals its work
 * tree copy. Returns the staged paths, or {partial} when some differ (git add -p, edits after
 * git add, a staged file deleted from the work tree).
 */
function stagedState(cfg, generated) {
  const staged = splitZ(git(cfg.root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { allowFail: true }).stdout);
  const unstaged = new Set(splitZ(git(cfg.root, ['diff', '--name-only', '-z'], { allowFail: true }).stdout));
  const partial = staged.filter((rel) => unstaged.has(rel) && !generated(rel));
  return { staged, partial };
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, {
    generate: { type: 'boolean' },
    strict: { type: 'boolean' },
    lenient: { type: 'boolean' },
    today: { type: 'string' },
    json: { type: 'boolean' },
    'pre-commit': { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length) {
    usageError(`unexpected argument "${positionals[0]}"`, usage);
    return 2;
  }
  if (values.strict && values.lenient) {
    usageError('--strict and --lenient exclude each other', usage);
    return 2;
  }
  if (values['pre-commit'] && values.lenient) {
    usageError('--pre-commit is always strict', usage);
    return 2;
  }
  if (!checkToday(values.today, usage)) return 2;
  const preCommit = Boolean(values['pre-commit']) && isGitRepo(cfg.root);
  const mode = values.lenient ? 'lenient' : 'strict';
  const generate = values.generate || values['pre-commit'];
  const isGenerated = (rel) => rel.startsWith(`${cfg.dirs.ai}/`) || rel === cfg.files.ignore || rel === cfg.files.home;

  let staged = [];
  if (preCommit) {
    const state = stagedState(cfg, isGenerated);
    if (state.partial.length) {
      process.stderr.write(`${cfg.t('check.partial_staged', { files: state.partial.join(', ') })}\n`);
      return 1;
    }
    staged = state.staged;
  }

  let vault = loadVault(cfg, { roots: 'all' });
  let generated = null;
  let normalized = [];
  if (generate) {
    normalized = normalizeNotes(vault);
    if (normalized.length) vault = loadVault(cfg, { roots: 'all' });
    try {
      const res = await writeGenerated(cfg, vault, { today: values.today });
      generated = { written: res.written.length, removed: res.removed.length, files: res.written };
    } catch (err) {
      // runChecks reports it as GEN_BUDGET or GEN_FAILED.
      generated = { error: err?.message ?? String(err) };
    }
  }
  const result = await runChecks(cfg, vault, { strict: mode === 'strict', today: values.today });

  if (values.json) {
    const out = { mode, errors: result.errors, warnings: result.warnings, notes: result.notes };
    if (generated) {
      out.generated = generated.error ? { error: generated.error } : { written: generated.written, removed: generated.removed };
    }
    if (normalized.length) out.normalized = normalized;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    if (normalized.length) {
      const files = normalized.map((n) => (n.root === 'main' ? n.rel : `${n.root}:${n.rel}`)).join(', ');
      process.stdout.write(`${cfg.t('check.normalized', { files })}\n`);
    }
    if (generated && !generated.error) process.stdout.write(`${cfg.t('check.generated', generated)}\n`);
    process.stdout.write(formatFindings(result, cfg, { mode }));
  }
  if (result.errors.length) return 1;

  if (preCommit) {
    // Stage what the kit itself rewrote: the generated views, the managed .gitignore block and
    // normalized staged notes (they equalled the work tree, so nothing unstaged sneaks in).
    const add = [cfg.dirs.ai, cfg.files.ignore, cfg.files.home];
    if (generated?.files?.includes('.gitignore')) add.push('.gitignore');
    // Notes are known by their NFC rel; git lists the name as stored (NFD on some disks).
    const stagedByNfc = new Map(staged.map((rel) => [rel.normalize('NFC'), rel]));
    for (const n of normalized) if (n.root === 'main' && stagedByNfc.has(n.rel)) add.push(stagedByNfc.get(n.rel));
    const present = add.filter((rel) => fs.existsSync(path.join(cfg.root, ...rel.split('/'))));
    if (present.length) {
      const res = git(cfg.root, ['add', '-A', '--', ...present], { allowFail: true });
      if (!res.ok) {
        process.stderr.write(`memory: git add failed: ${res.stderr.trim()}\n`);
        return 1;
      }
    }
  }
  return 0;
}
