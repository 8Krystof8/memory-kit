// connect --rules (lib/globalrules.mjs and commands/connect.mjs): the block in the agent's global
// instructions is added once, updated in place, taken out cleanly, and nothing else of the file
// changes; the CLI writes CLAUDE.md, AGENTS.md or GEMINI.md of a fake home, in both languages.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BEGIN, END, applyRules, rulesBlock, rulesFile, rulesVault } from '../../lib/globalrules.mjs';
import { fixtureVault, removeTmpDirs, runCli, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const block = rulesBlock({ lang: 'en', vault: '/v/memory', command: 'node "/v/memory/system/memory.mjs"' });

describe('the rules block', () => {
  test('its text: the markers, the vault, the command, the 📎 rule; Czech in a Czech vault', () => {
    assert.ok(block.startsWith(`${BEGIN}\n`) && block.endsWith(`${END}\n`));
    assert.match(block, /node "\/v\/memory\/system\/memory\.mjs" search "query"/);
    assert.match(block, /Cite only notes you opened/);
    assert.equal(rulesVault(block), '/v/memory');
    const cs = rulesBlock({ lang: 'cs', vault: '/v/pamet', command: 'node x' });
    assert.match(cs, /📎 z paměti:/);
    assert.equal(rulesVault(cs), '/v/pamet');
  });

  test('add, unchanged, update and remove; the rest of the file stays byte for byte, CRLF too', () => {
    const own = '# My rules\n\nBe brief.\n';
    const added = applyRules(own, block);
    assert.equal(added.action, 'add');
    assert.equal(added.text, `${own}\n${block}`);
    assert.equal(applyRules(added.text, block).action, 'unchanged');
    const other = rulesBlock({ lang: 'en', vault: '/v/other', command: 'node y' });
    const updated = applyRules(added.text, other);
    assert.equal(updated.action, 'update');
    assert.ok(updated.text.startsWith(own) && updated.text.includes('/v/other'));
    const removed = applyRules(updated.text, null);
    assert.deepEqual(removed, { text: own, action: 'remove' });
    assert.equal(applyRules(own, null).action, 'absent');
    assert.equal(applyRules('', block).text, block, 'a new file holds only the block');
    assert.equal(applyRules(block, null).text, '');
    const crlf = applyRules('a\r\nb\r\n', block).text;
    assert.ok(crlf.startsWith('a\r\nb\r\n\r\n<!--') && !/[^\r]\n/.test(crlf), 'CRLF kept');
  });

  test('damaged markers: a lost end or start line, or two blocks, change nothing', () => {
    const lostEnd = `# Mine\n${BEGIN}\nold\nMY NOTES\n`;
    assert.deepEqual(applyRules(lostEnd, block), { text: lostEnd, action: 'damaged' });
    const lostStart = `# Mine\nold\n${END}\nMY NOTES\n`;
    assert.equal(applyRules(lostStart, null).action, 'damaged');
    assert.equal(applyRules(`${block}\n${block}`, block).action, 'damaged');
  });

  test('the file of each agent', () => {
    const home = '/h';
    assert.equal(rulesFile('claude-code', { env: {}, home, platform: 'linux' }), path.join(home, '.claude', 'CLAUDE.md'));
    assert.equal(rulesFile('claude-code', { env: { CLAUDE_CONFIG_DIR: '/c' }, home, platform: 'linux' }), path.join('/c', 'CLAUDE.md'));
    assert.equal(rulesFile('codex', { env: {}, home, platform: 'linux' }), path.join(home, '.codex', 'AGENTS.md'));
    assert.equal(rulesFile('gemini-cli', { env: {}, home, platform: 'linux' }), path.join(home, '.gemini', 'GEMINI.md'));
    const h = tmpDir('rules-files');
    fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(h, '.codex', 'AGENTS.override.md'), 'x');
    assert.equal(rulesFile('codex', { env: {}, home: h, platform: 'linux' }), path.join(h, '.codex', 'AGENTS.override.md'), 'Codex reads the override first');
    fs.mkdirSync(path.join(h, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(h, '.gemini', 'settings.json'), JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } }));
    assert.equal(rulesFile('gemini-cli', { env: {}, home: h, platform: 'linux' }), path.join(h, '.gemini', 'AGENTS.md'), 'Gemini context.fileName');
  });
});

describe('connect --rules', () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: writes, keeps, removes; --dry-run writes nothing; a backup of the old file`, () => {
      const v = fixtureVault(lang);
      const home = tmpDir('rules-home');
      const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
      const file = path.join(home, '.claude', 'CLAUDE.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '# Mine\n');
      const dry = runCli(v.root, ['connect', 'claude-code', '--rules', '--dry-run', '--json'], { env });
      assert.equal(dry.code, 0, dry.stderr);
      assert.equal(JSON.parse(dry.stdout).action, 'add');
      assert.equal(fs.readFileSync(file, 'utf8'), '# Mine\n');
      const add = JSON.parse(runCli(v.root, ['connect', 'claude-code', '--rules', '--json'], { env }).stdout);
      assert.equal(add.action, 'add');
      assert.ok(fs.existsSync(add.backup));
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.startsWith('# Mine\n') && text.includes(lang === 'cs' ? 'Dlouhodobá paměť' : 'Long-term memory'));
      assert.equal(JSON.parse(runCli(v.root, ['connect', 'claude-code', '--rules', '--json'], { env }).stdout).action, 'unchanged');
      const codex = JSON.parse(runCli(v.root, ['connect', 'codex', '--rules', '--json'], { env }).stdout);
      assert.equal(codex.action, 'add', 'a new AGENTS.md');
      assert.equal(codex.backup, null);
      assert.ok(fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
      assert.equal(JSON.parse(runCli(v.root, ['connect', 'claude-code', '--rules', '--remove', '--json'], { env }).stdout).action, 'remove');
      assert.equal(fs.readFileSync(file, 'utf8'), '# Mine\n');
      assert.equal(runCli(v.root, ['connect', 'cursor', '--rules'], { env }).code, 2, 'only agents with a global instructions file');
    });
  }
});
