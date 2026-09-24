// `start`: prints the session start view (docs/architecture.md, 10.4). Never writes a file except
// the git setting core.hooksPath. Always exits 0: a broken start must not block a session.
// --format gemini-hook wraps the view for a Gemini CLI SessionStart hook; --format json prints
// {text, stale, initialized, failed}. The view itself comes from lib/startview.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { START_FORMATS, failedStartView, formatStartView, renderStartView } from '../startview.mjs';
import { checkToday, git, isGitRepo, parseCli, splitList, usageError } from '../util.mjs';

export const usage = 'start [--sectors a,b] [--today YYYY-MM-DD] [--format text|gemini-hook|json]';

// English defaults; packs may translate the same keys.
const DEFAULTS = {
  'start.bad_format': '--format must be text, gemini-hook or json, got "{value}"',
};

function say(cfg, key, vars) {
  const text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}

function ensureHooksPath(root) {
  try {
    if (!fs.existsSync(path.join(root, '.githooks', 'pre-commit')) || !isGitRepo(root)) return;
    const current = git(root, ['config', '--get', 'core.hooksPath'], { allowFail: true });
    if (current.stdout.trim() !== '.githooks') git(root, ['config', 'core.hooksPath', '.githooks'], { allowFail: true });
  } catch {
    /* git problems never break start */
  }
}

export async function run(argv, cfg) {
  let format = 'text';
  try {
    const parsed = parseCli(argv, {
      sectors: { type: 'string' },
      today: { type: 'string' },
      format: { type: 'string' },
    }, usage);
    if (!parsed || !checkToday(parsed.values.today, usage)) return 0;
    const wanted = parsed.values.format ?? 'text';
    if (!START_FORMATS.includes(wanted)) {
      usageError(say(cfg, 'start.bad_format', { value: wanted }), usage);
      return 0;
    }
    format = wanted;
    ensureHooksPath(cfg.root);
    const sectors = splitList(parsed.values.sectors ?? process.env.MEMORY_SECTORS);
    const view = await renderStartView(cfg, { sectors, today: parsed.values.today });
    process.stdout.write(formatStartView(view, format));
  } catch (err) {
    process.stdout.write(formatStartView(failedStartView(cfg, err), format));
  }
  return 0;
}
