// `start`: prints the session start view (docs/architecture.md, 10.4). Never writes a file except
// the git setting core.hooksPath. Always exits 0: a broken start must not block a session.

import fs from 'node:fs';
import path from 'node:path';
import { verifyStamp } from '../fingerprint.mjs';
import { buildContext, extractSearchBlock, renderStart } from '../generate.mjs';
import { loadVault } from '../vault.mjs';
import { bytes, checkToday, git, isGitRepo, parseCli, readTextIfExists, splitList } from '../util.mjs';

export const usage = 'start [--sectors a,b] [--today YYYY-MM-DD]';

function ensureHooksPath(root) {
  try {
    if (!fs.existsSync(path.join(root, '.githooks', 'pre-commit')) || !isGitRepo(root)) return;
    const current = git(root, ['config', '--get', 'core.hooksPath'], { allowFail: true });
    if (current.stdout.trim() !== '.githooks') git(root, ['config', 'core.hooksPath', '.githooks'], { allowFail: true });
  } catch {
    /* git problems never break start */
  }
}

/** Cuts text at a line boundary so that it fits maxBytes. */
function capBytes(text, maxBytes) {
  if (bytes(text) <= maxBytes) return text;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    const next = `${out}${line}\n`;
    if (bytes(next) > maxBytes) break;
    out = next;
  }
  return out;
}

export async function run(argv, cfg) {
  try {
    const parsed = parseCli(argv, { sectors: { type: 'string' }, today: { type: 'string' } }, usage);
    if (!parsed || !checkToday(parsed.values.today, usage)) return 0;
    const { today } = parsed.values;
    ensureHooksPath(cfg.root);

    const sectors = splitList(parsed.values.sectors ?? process.env.MEMORY_SECTORS);
    const vault = loadVault(cfg);
    const ctx = await buildContext(cfg, vault, { today });

    let text;
    if (sectors.length) {
      text = renderStart(cfg, vault, ctx, { sectors });
    } else {
      let committed = null;
      try {
        committed = fs.readFileSync(path.join(cfg.root, cfg.dirs.ai, 'start.md'), 'utf8');
      } catch {
        /* not generated yet */
      }
      const v = committed === null ? null : verifyStamp(committed);
      if (v?.ok && v.header.source === ctx.source) {
        text = committed;
      } else {
        text = `${renderStart(cfg, vault, ctx)}${cfg.t('start.stale')}\n`;
      }
    }
    if (!cfg.initialized) text = `${cfg.t('start.not_initialized')}\n${text}`;
    process.stdout.write(capBytes(text, cfg.budgets.hook_bytes));
  } catch (err) {
    process.stdout.write(capBytes(fallback(cfg, err), cfg?.budgets?.hook_bytes ?? 9500));
  }
  return 0;
}

/** When the start view cannot be built, the session still gets the search protocol and the rules. */
function fallback(cfg, err) {
  const t = (key, fallbackText) => {
    try {
      const out = cfg.t(key);
      return out && out !== key ? out : fallbackText;
    } catch {
      return fallbackText;
    }
  };
  const lines = [
    `# ${t('start.title', 'Memory: start')}`,
    `memory: start failed: ${err?.message ?? err}. Run node system/memory.mjs check.`,
  ];
  let block = null;
  try {
    block = extractSearchBlock(readTextIfExists(path.join(cfg.root, cfg.files?.agents ?? 'AGENTS.md')));
  } catch {
    /* no AGENTS.md */
  }
  if (block) lines.push('', `## ${t('start.search', 'How to search')}`, block);
  const safety = Array.isArray(cfg?.startSafety) ? cfg.startSafety : [];
  if (safety.length) lines.push('', `## ${t('start.safety', 'Writing and safety')}`, ...safety);
  return `${lines.join('\n')}\n`;
}
