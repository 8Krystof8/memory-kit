// generate.mjs on the fixture vaults: the AI view files, their headers, budgets and determinism
// (docs/architecture.md, section 8).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHeader, contentFingerprint } from '../../lib/fingerprint.mjs';
import {
  GenBudgetError, buildContext, expectedFiles, extractSearchBlock, renderStart, writeGenerated,
} from '../../lib/generate.mjs';
import {
  TODAY, cloneDir, fixtureVault, hashGenerated, loadFixture, readFile, removeTmpDirs, tmpDir, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const chars = (s) => [...s].length;

/**
 * Section lines of start.md: {heading: [lines]} in order, plus the head lines before any ##.
 * The counts line at the very end belongs to no section and is left out.
 */
function sections(text) {
  const out = { head: [] };
  let current = out.head;
  const lines = text.trimEnd().split('\n').slice(1, -1);
  for (const line of lines) {
    if (line.startsWith('## ')) {
      current = [];
      out[line.slice(3)] = current;
    } else if (line !== '') {
      current.push(line);
    }
  }
  return out;
}

async function generated(root, today = TODAY) {
  const { cfg, vault } = await loadFixture(root);
  const res = await writeGenerated(cfg, vault, { today });
  return { cfg, vault, res };
}

describe('extractSearchBlock (9.2)', () => {
  test('returns the lines strictly between the markers, trimmed of blank edges', () => {
    const text = 'intro\n<!-- search:start -->\n\n1. First\n2. Second\n\n<!-- search:end -->\nrest\n';
    assert.equal(extractSearchBlock(text), '1. First\n2. Second');
  });

  test('missing markers or an empty block give null', () => {
    assert.equal(extractSearchBlock('no markers'), null);
    assert.equal(extractSearchBlock('<!-- search:start -->\n1. x\n'), null);
    assert.equal(extractSearchBlock('<!-- search:start -->\n\n<!-- search:end -->\n'), null);
  });
});

for (const lang of ['en', 'cs']) {
  describe(`generated files (${lang})`, () => {
    let fx;
    let cfg;
    let vault;
    let res;
    let n;
    const file = (rel) => readFile(fx.root, rel);

    before(async () => {
      fx = fixtureVault(lang);
      n = fx.names;
      ({ cfg, vault, res } = await generated(fx.root));
    });

    test('the expected set of files, nothing else', () => {
      const expected = ['.gitignore', '.ignore', n.home, '_ai/catalog.tsv', '_ai/profile.md', '_ai/start.md',
        ...[n.core, n.hobbies, n.school, n.work].map((id) => `_ai/index-${id}.md`)].sort();
      assert.deepEqual([...res.written].sort(), expected);
      assert.ok(!fs.existsSync(path.join(fx.root, '_ai', `index-${n.health}.md`)), 'no index for a local sector');
      assert.equal(res.asOf, TODAY);
    });

    test('every file has a valid header with one shared source fingerprint', () => {
      for (const rel of res.written.filter((r) => r !== '.gitignore')) {
        const text = file(rel);
        const nl = text.indexOf('\n');
        const header = parseHeader(text.slice(0, nl));
        assert.ok(header, `${rel}: ${text.slice(0, nl)}`);
        assert.equal(header.source, res.source, rel);
        assert.equal(header.asOf, TODAY, rel);
        assert.equal(header.content, contentFingerprint(text.slice(nl + 1)), rel);
        const prefixed = rel.endsWith('.tsv') || rel === '.ignore';
        assert.equal(text.startsWith('# memory-kit v1 · '), prefixed, rel);
        assert.equal(text.startsWith('<!-- memory-kit v1 · '), rel === n.home, rel);
        assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${rel} ends with exactly one newline`);
      }
    });

    test('a second run writes nothing', async () => {
      const again = await generated(fx.root);
      assert.deepEqual(again.res.written, []);
      assert.deepEqual(again.res.removed, []);
      assert.equal(again.res.source, res.source);
    });

    test('start.md: order, search block verbatim, budget', () => {
      const text = file('_ai/start.md');
      assert.ok(bytes(text) <= 8500, `${bytes(text)} bytes`);
      const s = sections(text);
      const heading = (key) => cfg.t(key, { rel: cfg.profile, file: cfg.files.state, days: 14, asOf: TODAY, max: 20 });
      assert.deepEqual(Object.keys(s), ['head', heading('start.search'), heading('start.safety'), heading('start.sectors'),
        heading('start.profile'), heading('start.hot'), heading('start.now')]);
      assert.equal(s.head[0], `# ${cfg.t('start.title')}`);
      assert.match(s.head[1], new RegExp(`${TODAY}$`));
      const agents = fs.readFileSync(path.join(fx.root, 'AGENTS.md'), 'utf8');
      assert.ok(text.includes(`## ${heading('start.search')}\n${extractSearchBlock(agents)}\n`), 'search block byte for byte');
      assert.deepEqual(s[heading('start.safety')], cfg.startSafety);
      const last = text.trimEnd().split('\n').pop();
      assert.equal(last, cfg.t('start.counts', { waiting: 1, file: cfg.files.waiting, inbox: 2, version: cfg.kitVersion }));
    });

    test('start.md: sector table rows (on before sleep, then id; local rows point to the export)', () => {
      const rows = sections(file('_ai/start.md'))[cfg.t('start.sectors')].slice(2);
      const ids = rows.map((r) => r.split(' | ')[0].slice(2));
      const on = [n.core, n.health, n.school, n.work].sort();
      assert.deepEqual(ids, [...on, n.hobbies]);
      const local = rows.find((r) => r.startsWith(`| ${n.health} |`));
      assert.ok(local.includes(`_${n.health}${n.exportSuffix}.md`), local);
      const sleeping = rows.find((r) => r.startsWith(`| ${n.hobbies} |`));
      assert.ok(sleeping.includes(cfg.t('start.sleeping')), sleeping);
      for (const row of rows) {
        const cells = row.slice(2, -2).split(' | ');
        assert.equal(cells.length, 5, row);
        assert.ok(chars(cells[1]) <= 60 && chars(cells[2]) <= 60, row);
      }
    });

    test('start.md: hot list rules (8.2)', () => {
      const hot = sections(file('_ai/start.md'))[cfg.t('start.hot', { days: 14, asOf: TODAY, max: 20 })];
      assert.ok(hot.length > 0 && hot.length <= 20);
      const perSector = {};
      for (const line of hot) {
        const [rel, type, status, desc] = line.slice(2).split(' · ');
        const note = vault.byRel.get(rel);
        assert.ok(note, rel);
        assert.equal(note.area, 'sector');
        assert.equal(type, cfg.local('type', note.data.type));
        assert.equal(status, cfg.local('status', note.data.status));
        assert.ok(chars(desc) <= 80, desc);
        assert.ok(!['replaced', 'rejected'].includes(note.data.status));
        assert.notEqual(note.sector, n.hobbies, 'sleeping sectors have no hot notes');
        assert.ok(!note.isManifest && note.rel !== cfg.profile);
        perSector[note.sector] = (perSector[note.sector] ?? 0) + 1;
      }
      for (const count of Object.values(perSector)) assert.ok(count <= 5);
    });

    test('start.md: profile and Now sections', () => {
      const s = sections(file('_ai/start.md'));
      const profile = s[cfg.t('start.profile', { rel: cfg.profile })];
      assert.deepEqual(profile, vault.byRel.get(cfg.profile).lead.map((l) => `- ${l}`));
      const now = s[cfg.t('start.now', { file: cfg.files.state })];
      assert.equal(now.length, 3);
      assert.ok(now[0].startsWith('- '));
    });

    test('index: title, rules, links, groups and the outside line (8.4)', () => {
      const lines = file(`_ai/index-${n.work}.md`).split('\n');
      assert.equal(lines[1], `# ${cfg.t('index.title', { sector: n.work, notes: 18, dir: `${n.sectors}/${n.work}` })}`);
      assert.ok(lines[2].startsWith(`${cfg.t('index.rules')}: 1) `), lines[2]);
      assert.ok(lines[2].includes(' 2) '), lines[2]);
      assert.equal(lines[3], `${cfg.t('index.linked')}: ${n.core}, ${n.school}`);
      assert.ok(lines[4].includes(`--sector ${n.work}`), lines[4]);

      const groups = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
      const typeOrder = ['decision', 'rule', 'procedure', 'fact', 'insight', 'project', 'proposal', 'analysis', 'text', 'list', 'person', 'organization'];
      const expected = typeOrder.map((t) => cfg.local('type', t));
      assert.deepEqual(groups.slice(0, -1), expected);
      assert.equal(groups.at(-1), cfg.t('index.outside', { replaced: 1, rejected: 1, expired: 0, archived: 1 }));

      const decisions = lines.slice(lines.indexOf(`## ${cfg.local('type', 'decision')}`) + 1, lines.indexOf(`## ${cfg.local('type', 'rule')}`));
      assert.equal(decisions.length, 2, 'replaced and rejected decisions stay out');
      assert.ok(decisions[0].includes('2026-08-18-') && decisions[1].includes('2026-06-02-'), 'newest created first');
      assert.match(decisions[0], new RegExp(`^${n.decisions}/2026-08-18-[a-z0-9-]+\\.md · 08-18 · `), 'no status for decisions');
      const project = lines.find((l) => l.startsWith(lang === 'en' ? 'website-redesign.md' : 'redesign-webu-pekarny.md'));
      assert.match(project, new RegExp(`^[a-z-]+\\.md · ${cfg.local('status', 'active')} · 09-19 · H · `));
    });

    test('index: cross-links to other sectors', () => {
      const text = file(`_ai/index-${n.school}.md`);
      const thesis = lang === 'en' ? 'thesis-project' : 'maturita-rezervacni-aplikace';
      const redesign = lang === 'en' ? 'website-redesign' : 'redesign-webu-pekarny';
      assert.ok(text.includes(`## ${cfg.t('index.cross')}\n${thesis} → ${n.work}/${redesign}\n`), text);
    });

    test('catalog.tsv: one row per main-root note except inbox, sorted, 8 columns (8.5)', () => {
      const lines = file('_ai/catalog.tsv').trimEnd().split('\n');
      assert.equal(lines[1], '# path\ttype\tstatus\tupdated\ttier\tdescription\tnames\tstems');
      const rows = lines.slice(2).map((l) => l.split('\t'));
      const expected = vault.notes.filter((x) => x.root === 'main' && x.area !== 'inbox').map((x) => x.rel).sort();
      assert.deepEqual(rows.map((r) => r[0]), expected);
      for (const r of rows) {
        assert.equal(r.length, 8, r[0]);
        assert.ok(chars(r.join('\t')) <= 600, r[0]);
      }
      const archived = rows.find((r) => r[0].startsWith(`${n.archive}/`));
      assert.equal(archived[4], cfg.local('tier', 'archive'));
      const hotRels = sections(file('_ai/start.md'))[cfg.t('start.hot', { days: 14, asOf: TODAY, max: 20 })].map((l) => l.slice(2).split(' · ')[0]);
      for (const rel of hotRels) assert.equal(rows.find((r) => r[0] === rel)[4], cfg.local('tier', 'hot'), rel);
      assert.ok(!rows.some((r) => r[0].includes('dentist') || r[0].includes('zubar')), 'no local-root notes');
      const decision = rows.find((r) => r[0].includes(`/${n.decisions}/2026-06-02-`));
      assert.equal(decision[1], cfg.local('type', 'decision'));
      assert.ok(decision[7].split(' ').length > 1, 'stems column is filled');
    });

    test('profile.md: lead, on+github sectors, memory sentence, 1500 chars (8.6)', () => {
      const text = file('_ai/profile.md');
      const body = text.slice(text.indexOf('\n') + 1);
      assert.ok(chars(body) <= 1500);
      const lines = body.trimEnd().split('\n');
      assert.equal(lines[0], `# ${cfg.t('profile.title')}`);
      for (const lead of vault.byRel.get(cfg.profile).lead) assert.ok(lines.includes(lead), lead);
      const sectorsLine = lines.find((l) => l.startsWith(`${cfg.t('profile.sectors')}: `));
      const ids = sectorsLine.slice(sectorsLine.indexOf(': ') + 2).split('; ').map((p) => p.split(' ')[0]);
      assert.deepEqual(ids, [n.core, n.school, n.work].sort());
      assert.equal(lines.at(-1), cfg.t('profile.memory'));
    });

    test('.ignore: archive and sleeping sectors (8.7)', () => {
      const lines = file('.ignore').trimEnd().split('\n');
      assert.equal(lines[1], `# ${cfg.t('ignore.comment')}`);
      assert.deepEqual(lines.slice(2), [`${n.archive}/`, `/${n.home}`, `${n.sectors}/${n.hobbies}/`]);
    });

    test('home page: plain markdown with relative links, no local content (8.8)', () => {
      const home = file(n.home);
      assert.match(home, /^<!-- memory-kit v1 · .* · DO NOT EDIT -->\n# /);
      assert.ok(!home.includes('```'), 'no query blocks');
      assert.ok(!home.includes('![['), 'no embeds');
      assert.ok(home.includes(`](${n.sectors}/${n.work}/_${n.work}.md)`), 'sector link');
      assert.ok(home.includes(`](_ai/index-${n.work}.md)`), 'overview link');
      assert.ok(home.includes(`](${n.state})`) && home.includes(`](${n.waiting})`));
      assert.ok(!home.includes('dentist') && !home.includes('zubar'), 'nothing from the local root');
      assert.ok(!home.includes(`index-${n.health}.md`), 'no overview of a local sector');
    });

    test('.gitignore block: a local sector folder keeps only its manifest and export (6.3)', () => {
      const text = file('.gitignore');
      const dir = `${n.sectors}/${n.health}`;
      for (const line of [`/${dir}/*`, `!/${dir}/_${n.health}.md`, `!/${dir}/_${n.health}${n.exportSuffix}.md`]) {
        assert.ok(text.split('\n').includes(line), line);
      }
    });

    test('identical bytes whether or not the local root exists on this machine', async () => {
      const before = hashGenerated(fx.root);
      const away = `${fx.priv}-away`;
      fs.renameSync(fx.priv, away);
      try {
        const { cfg: c2, vault: v2 } = await loadFixture(fx.root);
        assert.equal(c2.roots[1].exists, false);
        const again = await writeGenerated(c2, v2, { today: TODAY });
        assert.deepEqual(again.written, []);
        assert.deepEqual(hashGenerated(fx.root), before);
      } finally {
        fs.renameSync(away, fx.priv);
      }
    });

    test('a copy in another place generates identical bytes', async () => {
      const copy = cloneDir(fx.base, path.join(tmpDir(`copy-${lang}`), 'elsewhere'));
      const root = path.join(copy, 'vault');
      fs.rmSync(path.join(root, '_ai'), { recursive: true });
      fs.rmSync(path.join(root, '.ignore'));
      await generated(root);
      assert.deepEqual(hashGenerated(root), hashGenerated(fx.root));
    });
  });
}

describe('time: as-of and the hot layer', () => {
  test('as-of falls back to system/cleanup/last.txt, then to the newest note date', async () => {
    const fx = fixtureVault('en');
    let { cfg, vault } = await loadFixture(fx.root);
    assert.equal((await buildContext(cfg, vault)).asOf, '2026-09-19', 'newest updated/created of a main-root note');
    writeFile(fx.root, 'system/cleanup/last.txt', '2026-09-22 0123abc\n');
    ({ cfg, vault } = await loadFixture(fx.root));
    assert.equal((await buildContext(cfg, vault)).asOf, '2026-09-22');
    assert.equal((await buildContext(cfg, vault, { today: '2026-10-01' })).asOf, '2026-10-01', '--today wins');
  });

  test('a note used in a recent journal entry is hot even when old; pinned notes come first', async () => {
    const fx = fixtureVault('en');
    const outline = 'sectors/school/thesis-outline.md';
    writeFile(fx.root, outline, readFile(fx.root, outline).replace('updated: 2026-09-10', 'updated: 2026-01-10'));
    const invoice = 'sectors/work/invoice-numbering.md';
    writeFile(fx.root, invoice, readFile(fx.root, invoice).replace('updated: 2026-01-05', 'updated: 2026-01-05\npin: true'));
    const { cfg, vault } = await loadFixture(fx.root);
    const ctx = await buildContext(cfg, vault, { today: TODAY });
    assert.ok(ctx.hot.has(outline), 'named in used of the 2026-09-18 journal entry');
    assert.ok(ctx.hot.has(invoice), 'pinned');
    const hotLines = sections(renderStart(cfg, vault, ctx))[cfg.t('start.hot', { days: 14, asOf: TODAY, max: 20 })];
    assert.ok(hotLines[0].startsWith(`- ${invoice} · `), hotLines[0]);

    const later = await buildContext(cfg, vault, { today: '2026-10-20' });
    assert.ok(!later.hot.has(outline), 'the journal entry is older than 14 days');
    assert.ok(later.hot.has(invoice), 'a pin never expires');
  });

  test('review_on due marks index rows with (verify)', async () => {
    const fx = fixtureVault('en');
    const rel = 'sectors/work/hosting-provider.md';
    writeFile(fx.root, rel, readFile(fx.root, rel).replace('review_on: 2026-11-01', 'review_on: 2026-09-01'));
    await generated(fx.root);
    const row = readFile(fx.root, '_ai/index-work.md').split('\n').find((l) => l.startsWith('hosting-provider.md'));
    assert.ok(row.includes(' · (verify) · '), row);
  });

  test('an expired fact leaves the index and is counted outside', async () => {
    const fx = fixtureVault('en');
    await generated(fx.root, '2027-01-05');
    const index = readFile(fx.root, '_ai/index-work.md');
    assert.ok(!index.split('\n').some((l) => l.startsWith('pricing.md')), 'valid_until 2026-12-31 has passed');
    assert.ok(index.includes('expired 1'), index.split('\n').at(-2));
  });
});

describe('session narrowing and sector states', () => {
  test('renderStart with sectors shows only those sectors and their hot notes', async () => {
    const fx = fixtureVault('en');
    const { cfg, vault } = await loadFixture(fx.root);
    const ctx = await buildContext(cfg, vault, { today: TODAY });
    const s = sections(renderStart(cfg, vault, ctx, { sectors: ['school'] }));
    const rows = s[cfg.t('start.sectors')].slice(2);
    assert.deepEqual(rows.map((r) => r.split(' | ')[0]), ['| school']);
    const hot = s[cfg.t('start.hot', { days: 14, asOf: TODAY, max: 20 })];
    assert.ok(hot.length > 0 && hot.every((l) => l.startsWith('- sectors/school/')), hot.join('\n'));
  });

  test('an off sector leaves start, its index is removed, the archive covers it', async () => {
    const fx = fixtureVault('en');
    await generated(fx.root);
    assert.ok(fs.existsSync(path.join(fx.root, '_ai', 'index-hobbies.md')));
    const from = path.join(fx.root, 'sectors', 'hobbies');
    const to = path.join(fx.root, 'archive', 'sectors', 'hobbies');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    const manifest = 'archive/sectors/hobbies/_hobbies.md';
    writeFile(fx.root, manifest, readFile(fx.root, manifest).replace('state: sleep', 'state: off'));
    const { res } = await generated(fx.root);
    assert.deepEqual(res.removed, ['_ai/index-hobbies.md']);
    assert.ok(!readFile(fx.root, '_ai/start.md').includes('| hobbies |'));
    assert.deepEqual(readFile(fx.root, '.ignore').trimEnd().split('\n').slice(2), ['archive/', '/home.md']);
    const catalog = readFile(fx.root, '_ai/catalog.tsv');
    assert.match(catalog, /\narchive\/sectors\/hobbies\/climbing-log\.md\t[^\t]*\t[^\t]*\t[^\t]*\tarchive\t/);
  });
});

describe('start.md budget (8.3)', () => {
  // A vault that overflows start.md: a long search block, 20 hot notes with long paths,
  // 15 long Now lines and a 6-line profile.
  function heavyVault() {
    const fx = fixtureVault('en');
    const agents = readFile(fx.root, 'AGENTS.md');
    const extra = Array.from({ length: 16 }, (_, i) => `${11 + i}. ${'Extra search guidance for the budget test. '.repeat(4).trim()}`).join('\n');
    writeFile(fx.root, 'AGENTS.md', agents.replace('\n<!-- search:end -->', `\n${extra}\n<!-- search:end -->`));
    const manifest = 'sectors/work/_work.md';
    writeFile(fx.root, manifest, readFile(fx.root, manifest).replace('privacy: github', 'privacy: github\nhot_max: 20'));
    const shelf = 'sectors/work/budget-test-shelf-with-a-long-name/another-deep-shelf-for-long-paths';
    for (let i = 0; i < 20; i++) {
      const name = `note-${String(i).padStart(2, '0')}-with-a-rather-long-descriptive-file-name-for-tests`;
      writeFile(fx.root, `${shelf}/${name}.md`, [
        '---', 'type: project', 'status: active',
        `description: ${'A long description that will be cut in the hot list of start. '.repeat(3).trim()}`,
        'updated: 2026-09-19', '---', `# Note ${i}`, '',
      ].join('\n'));
    }
    const now = Array.from({ length: 15 }, (_, i) => `- Now line ${i + 1}: ${'status of an ongoing piece of work with some detail '.repeat(3).trim()}`);
    writeFile(fx.root, 'state.md', readFile(fx.root, 'state.md').replace(/## Now\n[\s\S]*?\n\n## Next/, `## Now\n${now.join('\n')}\n\n## Next`));
    const lead = Array.from({ length: 6 }, (_, i) => `> Profile line ${i + 1}: ${'how I like to work and what to keep in mind '.repeat(3).trim()}`);
    writeFile(fx.root, 'sectors/core/profile.md', readFile(fx.root, 'sectors/core/profile.md').replace(/(# Profile\n\n)(> .*\n)+/, `$1${lead.join('\n')}\n`));
    return fx;
  }

  test('trims hot lines to 5 before Now lines, keeps the profile, fits 8500 bytes', async () => {
    const fx = heavyVault();
    const { cfg, vault } = await loadFixture(fx.root);
    const ctx = await buildContext(cfg, vault, { today: TODAY });
    const text = renderStart(cfg, vault, ctx);
    assert.ok(bytes(text) <= 8500, `${bytes(text)} bytes`);
    const s = sections(text);
    const hot = s[cfg.t('start.hot', { days: 14, asOf: TODAY, max: 20 })];
    const now = s[cfg.t('start.now', { file: cfg.files.state })];
    const profile = s[cfg.t('start.profile', { rel: cfg.profile })];
    assert.equal(hot.length, 5, 'hot lines are trimmed first, down to 5');
    assert.ok(now.length >= 5 && now.length < 15, `Now lines trimmed second: ${now.length}`);
    assert.equal(profile.length, 6, 'profile untouched while Now lines can go');
  });

  test('an impossible budget throws GenBudgetError', async () => {
    const fx = fixtureVault('en');
    const block = Array.from({ length: 120 }, (_, i) => `${i + 1}. ${'x'.repeat(80)}`).join('\n');
    writeFile(fx.root, 'AGENTS.md', `<!-- kit:start -->\n<!-- search:start -->\n${block}\n<!-- search:end -->\n<!-- kit:end -->\n`);
    const { cfg, vault } = await loadFixture(fx.root);
    const ctx = await buildContext(cfg, vault, { today: TODAY });
    assert.throws(() => renderStart(cfg, vault, ctx), (err) => err instanceof GenBudgetError && err.code === 'GEN_BUDGET');
    assert.throws(() => expectedFiles(cfg, vault, ctx), GenBudgetError);
  });
});
