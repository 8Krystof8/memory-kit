// `start`: prints the session start view (docs/architecture.md, 10.4). Writes no file except the
// git setting core.hooksPath, one line of the activity log (lib/activity.mjs) and the notes of the
// update check (lib/updates.mjs). Always exits 0: a broken start must not block a session.
// --format claude-hook wraps the view for the vault's Claude Code SessionStart hook together with
// the owner's lines (memory.json feedback.notice; a newer kit once a day), --format gemini-hook for
// a Gemini CLI SessionStart hook; --format json prints {text, stale, initialized, failed}. The view
// itself comes from lib/startview.mjs. With "updates": {"check": true} it starts the daily check.

import fs from 'node:fs';
import path from 'node:path';
import { agentFromEnv, logActivity } from '../activity.mjs';
import { START_FORMATS, buildStartView, failedStartView, formatStartView, startNotice } from '../startview.mjs';
import { checkInBackground, updateLine } from '../updates.mjs';
import { checkToday, git, isGitRepo, parseCli, splitList, usageError } from '../util.mjs';

export const usage = 'start [--sectors a,b] [--today YYYY-MM-DD] [--format text|claude-hook|gemini-hook|json]';

// English defaults; packs may translate the same keys.
const DEFAULTS = {
  'start.bad_format': '--format must be text, claude-hook, gemini-hook or json, got "{value}"',
};

// The agent whose hook asks for a format; for the others the marks in the environment tell.
const FORMAT_AGENT = { 'claude-hook': 'claude-code', 'gemini-hook': 'gemini-cli' };

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
    const built = await buildStartView(cfg, { sectors, today: parsed.values.today });
    // The owner's lines: the memory loaded, and a newer kit a check found (once a day).
    const notice = format === 'claude-hook'
      ? [startNotice(cfg, built), updateLine(cfg)].filter(Boolean).join('\n') || null
      : null;
    process.stdout.write(formatStartView(built.view, format, { notice, maxBytes: cfg.budgets.hook_bytes }));
    logActivity(cfg, { via: 'cli', op: 'start', agent: FORMAT_AGENT[format] ?? agentFromEnv() });
    // memory.json "updates": {"check": true}: at most once a day, in the background.
    checkInBackground(cfg);
  } catch (err) {
    const view = failedStartView(cfg, err);
    const notice = format === 'claude-hook' ? startNotice(cfg, { view, counts: null, error: String(err?.message ?? err) }) : null;
    process.stdout.write(formatStartView(view, format, { notice, maxBytes: cfg?.budgets?.hook_bytes }));
    logActivity(cfg, { via: 'cli', op: 'start', agent: FORMAT_AGENT[format] ?? agentFromEnv() });
  }
  return 0;
}
