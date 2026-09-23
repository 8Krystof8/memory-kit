// check.mjs: every rule of section 11 with its severity in strict and lenient mode.
// Each case copies a generated fixture vault, breaks one thing and runs the checks in-process.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RULES, formatFindings, runChecks } from '../../lib/check.mjs';
import { writeGenerated } from '../../lib/generate.mjs';
import {
  TODAY, cloneDir, describeFindings, fixtureVault, loadFixture, plantSecret, readFile, removeTmpDirs,
  tmpDir, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

// ---------------------------------------------------------------------------------------------
// Helpers

const bases = {};

async function baseVault(lang) {
  if (!bases[lang]) {
    const fx = fixtureVault(lang);
    const { cfg, vault } = await loadFixture(fx.root);
    await writeGenerated(cfg, vault, { today: TODAY });
    bases[lang] = fx;
  }
  return bases[lang];
}

/** A fresh copy of the generated fixture vault: {root, priv}. */
async function variant(lang = 'en') {
  const fx = await baseVault(lang);
  const dest = path.join(tmpDir(`check-${lang}`), 'copy');
  cloneDir(fx.base, dest);
  return { root: path.join(dest, 'vault'), priv: path.join(dest, 'private') };
}

async function check(root, { strict = true } = {}) {
  const { cfg, vault } = await loadFixture(root);
  return runChecks(cfg, vault, { strict, today: TODAY });
}

const edit = (root, rel, fn) => writeFile(root, rel, fn(readFile(root, rel)));
const note = (fm, body = '# Title\n\n> Lead.\n') => `---\n${fm.join('\n')}\n---\n${body}`;
const fact = (extra = [], body) => note(['type: fact', 'status: active', 'description: A test fact.', 'updated: 2026-09-01',
  'valid_until: 2027-01-01', ...extra], body);
const manifest = (id, state = 'on') => note([
  'type: sector', 'status: active', `description: Sector ${id}.`, 'updated: 2026-09-01',
  `keywords: [${id}, one, two, three, four]`, `state: ${state}`, 'privacy: github',
  `when_here: Anything about ${id}.`, 'not_here: Everything else.',
], `# ${id}\n`);
const lines = (n, prefix = '- line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

// ---------------------------------------------------------------------------------------------
// Cases: code, severity in strict / lenient ('error' | 'warning'), other error codes allowed.

const S = { strict: 'error', lenient: 'error' };
const D = { strict: 'error', lenient: 'warning' };
const W = { strict: 'warning', lenient: 'warning' };

const CASES = [
  ['FM_MISSING', D, (r) => writeFile(r, 'sectors/work/bare-note.md', '# Bare\n\nNo frontmatter.\n')],
  ['FM_PARSE', D, (r) => writeFile(r, 'sectors/work/nested-yaml.md', fact(['nested:', '  child: value']))],
  ['FM_REQUIRED', D, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace(/^description: .*\n/m, ''))],
  ['FM_CREATED', D, (r) => edit(r, 'sectors/work/decisions/2026-08-18-no-work-on-weekends.md', (t) => t.replace(/^created: .*\n/m, ''))],
  ['FM_TYPE', D, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace('type: fact', 'type: memo'))],
  ['FM_STATUS', D, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace('status: active', 'status: finished'))],
  ['FM_DATE', D, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace('updated: 2026-09-15', 'updated: 2026-02-30'))],
  ['NAME_FORMAT', D, (r) => writeFile(r, 'sectors/work/Bad_Name.md', fact())],
  ['NAME_GENERIC', D, (r) => writeFile(r, 'sectors/work/notes.md', fact())],
  ['NAME_DUPLICATE', D, (r) => writeFile(r, 'sectors/school/pricing.md', fact())],
  ['DATED_NAME', D, (r) => writeFile(r, 'sectors/work/decisions/undated-choice.md',
    note(['type: decision', 'status: active', 'description: A choice.', 'updated: 2026-09-01', 'created: 2026-09-01']))],
  ['DECISION_PLACE', D, (r) => writeFile(r, 'sectors/work/2026-09-01-misplaced-choice.md',
    note(['type: decision', 'status: active', 'description: A choice.', 'updated: 2026-09-01', 'created: 2026-09-01']))],
  ['JOURNAL_PLACE', D, (r) => writeFile(r, 'sectors/work/2026-09-01-stray-session.md',
    note(['type: journal', 'status: done', 'description: A session.', 'updated: 2026-09-01', 'created: 2026-09-01']))],
  ['NFC', D, (r) => writeFile(r, 'sectors/work/decomposed-text.md', fact([], '# Title\n\nPra\u0301ce.\n'))],
  ['SECTOR_NO_MANIFEST', D, (r) => writeFile(r, 'sectors/extra/orphan-note.md', fact())],
  ['SECTOR_ID', D, (r) => writeFile(r, 'sectors/Bad_Sector/_Bad_Sector.md', manifest('Bad_Sector')), ['GEN_MISSING']],
  ['MANIFEST_FIELDS', D, (r) => edit(r, 'sectors/school/_school.md', (t) => t.replace(/^when_here: .*\n/m, ''))],
  ['SECTOR_STATE_PLACE', D, (r) => edit(r, 'sectors/hobbies/_hobbies.md', (t) => t.replace('state: sleep', 'state: off'))],
  ['SECTORS_ON', W, (r) => {
    for (const id of ['s1', 's2', 's3', 's4', 's5']) writeFile(r, `sectors/${id}/_${id}.md`, manifest(id));
  }, ['GEN_MISSING']],
  ['SECTORS_ON', D, (r) => {
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) writeFile(r, `sectors/${id}/_${id}.md`, manifest(id));
  }, ['GEN_MISSING']],
  ['DESC_LONG', W, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace(/^description: .*$/m, `description: ${'x'.repeat(170)}`))],
  ['DESC_LONG', D, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace(/^description: .*$/m, `description: ${'x'.repeat(210)}`))],
  ['NOTE_LONG', W, (r) => writeFile(r, 'sectors/work/long-fact.md', fact([], `# Long\n\n${lines(85)}\n`))],
  ['NOTE_LONG', D, (r) => writeFile(r, 'sectors/work/long-fact.md', fact([], `# Long\n\n${lines(160)}\n`))],
  ['LINE_LONG', W, (r) => writeFile(r, 'sectors/work/wide-fact.md', fact([], `# Wide\n\n${'w'.repeat(850)}\n`))],
  ['LINE_LONG', D, (r) => writeFile(r, 'sectors/work/wide-fact.md', fact([], `# Wide\n\n${'w'.repeat(1100)}\n`))],
  ['STATE_LONG', D, (r) => edit(r, 'state.md', (t) => t.replace('## Now\n', `## Now\n${lines(16)}\n`))],
  ['WAITING_OPEN', W, (r) => edit(r, 'waiting.md', (t) => `${t}\n${lines(15, '## W-extra')}\n`)],
  ['WAITING_OPEN', D, (r) => edit(r, 'waiting.md', (t) => `${t}\n${lines(20, '## W-extra')}\n`)],
  ['AGENTS_SIZE', W, (r) => edit(r, 'AGENTS.md', (t) => `${t}${lines(130 - t.trimEnd().split('\n').length, '-')}\n`)],
  ['AGENTS_SIZE', D, (r) => edit(r, 'AGENTS.md', (t) => `${t}${lines(160 - t.trimEnd().split('\n').length, '-')}\n`)],
  ['CLAUDE_SIZE', W, (r) => writeFile(r, 'CLAUDE.md', `@AGENTS.md\n${lines(29)}\n`)],
  ['CLAUDE_SIZE', D, (r) => writeFile(r, 'CLAUDE.md', `@AGENTS.md\n${lines(44)}\n`)],
  ['ATTACHMENT_SIZE', W, (r) => writeFile(r, 'attachments/photo.png', Buffer.alloc(400 * 1024))],
  ['ATTACHMENT_SIZE', D, (r) => writeFile(r, 'attachments/photo.png', Buffer.alloc(600 * 1024))],
  ['FM_CRLF', W, (r) => writeFile(r, 'sectors/work/windows-note.md', fact().replace(/\n/g, '\r\n'))],
  ['FM_BOM', W, (r) => writeFile(r, 'sectors/work/bom-note.md', `\uFEFF${fact()}`)],
  ['LINK_BROKEN', W, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}- See [[no-such-note]].\n`)],
  ['NAME_ALIAS_CLASH', W, (r) => writeFile(r, 'sectors/work/price-sheet.md', fact(['aliases: [pricing]']))],
  ['DOC_TOC', W, (r) => writeFile(r, 'sectors/work/long-project.md', note(
    ['type: project', 'status: active', 'description: A long project.', 'updated: 2026-09-01'], `# Long project\n\n${lines(110)}\n`))],
  ['FACT_VALIDITY', W, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace(/^valid_until: .*\n/m, ''))],
  ['EXPIRED', W, (r) => edit(r, 'sectors/work/pricing.md', (t) => t.replace('valid_until: 2026-12-31', 'valid_until: 2026-09-01'))],
  ['REVIEW_DUE', W, (r) => edit(r, 'sectors/work/hosting-provider.md', (t) => t.replace('review_on: 2026-11-01', 'review_on: 2026-09-01'))],
  ['REPLACED_LINK', W, (r) => edit(r, 'sectors/work/competitor-analysis.md', (t) => t.replace('status: done', 'status: replaced'))],
  ['MANIFEST_KEYWORDS', W, (r) => edit(r, 'sectors/school/_school.md', (t) => t.replace(/^keywords: .*$/m, 'keywords: [school]'))],
  ['HUB_TYPE', W, (r) => edit(r, 'waiting.md', (t) => t.replace('type: hub', 'type: list'))],
  ['INBOX_AGE', W, (r) => writeFile(r, 'inbox/2026-09-01-old-idea.md', 'An idea that waits too long.\n')],
  ['GEN_STALE', W, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}- One more line.\n`)],
  ['GEN_ORPHAN', W, (r) => writeFile(r, '_ai/index-ghost.md', 'not generated\n')],
  ['GEN_EDITED', S, (r) => edit(r, '_ai/catalog.tsv', (t) => `${t}hand\tedited\n`)],
  ['GEN_MISSING', D, (r) => fs.rmSync(path.join(r, '_ai', 'profile.md'))],
  ['GEN_BUDGET', S, (r) => {
    const block = Array.from({ length: 120 }, (_, i) => `${i + 1}. ${'x'.repeat(80)}`).join('\n');
    edit(r, 'AGENTS.md', (t) => t.replace('<!-- search:end -->', `${block}\n<!-- search:end -->`));
  }, ['AGENTS_SIZE']],
  ['ROOT_MISSING', W, (r, p) => fs.renameSync(p, `${p}-away`)],
  ['LOCAL_UNKNOWN_SECTOR', W, (r, p) => writeFile(p, 'sectors/unknown/stray-note.md', fact())],
  ['SECRET', S, (r) => writeFile(r, 'sectors/work/api-notes.md', fact([], `# API\n\nkey ${plantSecret().aws}\n`))],
  ['PRIVACY_LINK', S, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}- Private: [[dentist-appointments]].\n`)],
  ['PRIVACY_LINK', S, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}- [bp](../../../private/sectors/health/dentist-appointments.md)\n`)],
  ['PRIVACY_LINK', S, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}| a | [[dentist-appointments\\|table alias]] |\n`)],
  ['PRIVACY_LINK', S, (r) => edit(r, 'sectors/work/pricing.md', (t) => `${t}~~~\n\`\`\`\n~~~\nSee [[dentist-appointments]].\n`)],
  ['FM_DATE_FUTURE', W, (r) => writeFile(r, 'sectors/work/typo-date.md', note(['type: insight', 'status: active', 'description: A typo.', 'updated: 2206-09-10']))],
  ['GITIGNORE_LOCAL', W, (r) => writeFile(r, '.gitignore', 'node_modules/\n')],
  ['LOCAL_IN_GIT', S, (r) => writeFile(r, 'sectors/health/copied-plan.md', fact())],
  ['AGENTS_MARKERS', S, (r) => edit(r, 'AGENTS.md', (t) => t.replace('<!-- search:start -->', '').replace('<!-- search:end -->', ''))],
  ['ADAPTER_IMPORT', S, (r) => writeFile(r, 'GEMINI.md', 'Read the rules in AGENTS.md.\n')],
  ['CONFIG', W, (r) => edit(r, 'memory.json', (t) => {
    const json = JSON.parse(t);
    json.budgets = { hot_total: 99 };
    return JSON.stringify(json, null, 2);
  })],
];

// ---------------------------------------------------------------------------------------------

describe('fixture vaults are clean', () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: no errors and no warnings in strict mode`, async () => {
      const { root } = await variant(lang);
      const res = await check(root);
      assert.equal(res.errors.length + res.warnings.length, 0, describeFindings(res));
      assert.ok(res.notes >= 40, `${res.notes} notes`);
    });
  }
});

describe('rules (section 11)', () => {
  test('RULES lists every code with its kind', () => {
    const kinds = Object.fromEntries(RULES.map((r) => [r.code, r.kind]));
    for (const [code, sev] of CASES) {
      assert.ok(kinds[code], `${code} missing from RULES`);
      if (sev === S) assert.equal(kinds[code], 'system', code);
    }
    for (const code of ['SECRET', 'PRIVACY_LINK', 'LOCAL_IN_GIT', 'GEN_EDITED', 'GEN_BUDGET', 'GEN_FAILED', 'AGENTS_MARKERS', 'ADAPTER_IMPORT']) {
      assert.equal(kinds[code], 'system', code);
    }
    for (const code of ['FM_FOREIGN_KEY', 'LINK_BROKEN', 'GEN_STALE', 'INBOX_AGE', 'START_BUDGET']) assert.equal(kinds[code], 'warn', code);
  });

  for (const [code, sev, mutate, alsoErrors = []] of CASES) {
    const label = sev === S ? 'system' : sev === D ? 'data' : 'warning';
    test(`${code} (${label})`, async () => {
      const { root, priv } = await variant('en');
      mutate(root, priv);
      for (const mode of ['strict', 'lenient']) {
        const res = await check(root, { strict: mode === 'strict' });
        const all = [...res.errors, ...res.warnings];
        const hit = all.find((f) => f.code === code);
        assert.ok(hit, `${mode}: ${code} not reported\n${describeFindings(res)}`);
        assert.equal(hit.severity, sev[mode], `${mode}: ${code} severity\n${describeFindings(res)}`);
        assert.equal(typeof hit.msg, 'string');
        assert.ok(hit.msg.length > 0);
        const unexpected = res.errors.filter((f) => f.code !== code && !alsoErrors.includes(f.code));
        assert.deepEqual(unexpected, [], `${mode}: other errors\n${describeFindings(res)}`);
      }
    });
  }

  test('FM_FOREIGN_KEY: English keys and values in a Czech vault are accepted with a warning', async () => {
    const { root } = await variant('cs');
    edit(root, 'sektory/prace/rozsah-balicku.md', (t) => t.replace('typ: fakt', 'type: fact'));
    const res = await check(root);
    const foreign = res.warnings.filter((f) => f.code === 'FM_FOREIGN_KEY');
    assert.ok(foreign.length >= 1, describeFindings(res));
    assert.ok(!res.errors.some((f) => f.code === 'FM_REQUIRED' || f.code === 'FM_TYPE'), describeFindings(res));
  });

  test('the SECRET message never contains the key', async () => {
    const { root } = await variant('en');
    const { aws } = plantSecret();
    writeFile(root, 'sectors/work/api-notes.md', fact([], `# API\n\nkey ${aws}\n`));
    const res = await check(root);
    const { cfg } = await loadFixture(root);
    const text = formatFindings(res, cfg, { mode: 'strict' });
    assert.ok(text.includes('SECRET'));
    assert.ok(!text.includes(aws));
    assert.ok(!JSON.stringify(res).includes(aws));
  });
});

describe('runChecks options and output', () => {
  test('findings are sorted by rel, line, code', async () => {
    const { root } = await variant('en');
    writeFile(root, 'sectors/work/a-first.md', note(['type: memo', 'status: odd', 'description: x', 'updated: 2026-13-01']));
    writeFile(root, 'sectors/work/b-second.md', '# none\n');
    const res = await check(root);
    const all = [...res.errors];
    const key = (f) => [f.rel, String(f.line).padStart(6, '0'), f.code].join('\u0000');
    assert.deepEqual(all.map(key), [...all].map(key).sort());
  });

  test('only and notesOnly limit the rules', async () => {
    const { root } = await variant('en');
    writeFile(root, 'sectors/work/api-notes.md', fact([], `# API\n\nkey ${plantSecret().github}\n`));
    writeFile(root, 'sectors/work/bare-note.md', '# no frontmatter\n');
    const { cfg, vault } = await loadFixture(root);
    const res = await runChecks(cfg, vault, { only: ['SECRET'], notesOnly: true, today: TODAY });
    assert.deepEqual([...new Set(res.errors.map((f) => f.code))], ['SECRET']);
    assert.deepEqual(res.warnings, []);
  });

  test('formatFindings: one line per finding, WARN padded, summary last', async () => {
    const { root } = await variant('en');
    writeFile(root, 'sectors/work/bare-note.md', '# no frontmatter\n');
    edit(root, 'sectors/work/pricing.md', (t) => `${t}- See [[no-such-note]].\n`);
    const res = await check(root);
    const { cfg } = await loadFixture(root);
    const out = formatFindings(res, cfg, { mode: 'strict' }).trimEnd().split('\n');
    assert.match(out[0], /^ERROR FM_MISSING sectors\/work\/bare-note\.md(:1)? no frontmatter$/);
    assert.ok(out.some((l) => /^WARN {2}LINK_BROKEN sectors\/work\/pricing\.md:\d+ \[\[no-such-note\]\] not found$/.test(l)), out.join('\n'));
    assert.equal(out.at(-1), `(${res.errors.length} errors · ${res.warnings.length} warnings · ${res.notes} notes · strict)`);
  });

  test('formatFindings caps the list', async () => {
    const { cfg } = await loadFixture((await variant('en')).root);
    const many = Array.from({ length: 205 }, (_, i) => ({ code: 'LINK_BROKEN', severity: 'warning', rel: `n${i}.md`, line: 1, msg: 'x' }));
    const out = formatFindings({ errors: [], warnings: many, notes: 1 }, cfg, { mode: 'lenient', max: 200 }).trimEnd().split('\n');
    assert.equal(out.length, 202);
    assert.equal(out[200], '(… 5 more)');
  });
});

describe('the configured local root is optional on this machine', () => {
  test('without the local root: a warning, never an error', async () => {
    const { root, priv } = await variant('en');
    fs.renameSync(priv, `${priv}-away`);
    const res = await check(root);
    assert.deepEqual(res.errors, [], describeFindings(res));
    assert.ok(res.warnings.some((f) => f.code === 'ROOT_MISSING'));
  });

  test('sector add --privacy local is refused without a local root', async () => {
    const { root } = await variant('en');
    edit(root, 'memory.json', (t) => {
      const json = JSON.parse(t);
      json.roots = json.roots.slice(0, 1);
      return JSON.stringify(json, null, 2);
    });
    const { cfg } = await loadFixture(root);
    const { addSector } = await import('../../lib/commands/sector.mjs');
    await assert.rejects(addSector(cfg, { id: 'family', privacy: 'local', today: TODAY }));
  });
});
