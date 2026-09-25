// `setup`: the interactive setup in a terminal. In a vault that is set up it opens the extras
// menu (connect AI apps, memory for coding projects, a health check); in one that is not, the
// whole setup wizard of init. Both live in lib/wizard.mjs. Without a terminal (a pipe, CI, an
// agent) it only says which commands do the same without questions and exits 2; --interactive
// runs it anyway, every question then taking its default, and a vault that is not set up is set
// up only with --yes (nobody saw the answers).

import path from 'node:path';
import { parseCli, usageError } from '../util.mjs';

export const usage = 'setup [--interactive] [--yes]';

export async function run(argv, cfg, ctx = {}) {
  const parsed = parseCli(argv, { interactive: { type: 'boolean' }, yes: { type: 'boolean' } }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length) {
    usageError(`unexpected argument "${positionals[0]}"`, usage);
    return 2;
  }
  const root = path.resolve(ctx.root ?? cfg?.root ?? '.');
  const [{ createUI }, wizard] = await Promise.all([import('../tui.mjs'), import('../wizard.mjs')]);
  const ui = ctx.ui ?? createUI();
  if (!ui.tty && !values.interactive) {
    const t = (key) => {
      const text = cfg?.t ? cfg.t(key) : key;
      return text !== key ? text : wizard.WIZARD_DEFAULTS[key];
    };
    process.stderr.write(`memory: ${t('setup.no_tty')}\n`);
    return 2;
  }
  return wizard.runSetup({ root, cfg, ui, opts: { yes: Boolean(values.yes) } });
}
