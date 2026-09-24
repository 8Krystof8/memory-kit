// Kit invariants: the rules files, adapters, templates, git defaults and the starter vault
// (docs/architecture.md, sections 2.2, 9 and 15.3 item 11).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../../lib/frontmatter.mjs';
import { extractSearchBlock } from '../../lib/generate.mjs';
import { KIT_ROOT, checkJson, copyKit, describeFindings, removeTmpDirs, runCli, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const read = (rel) => fs.readFileSync(path.join(KIT_ROOT, ...rel.split('/')), 'utf8');
const exists = (rel) => fs.existsSync(path.join(KIT_ROOT, ...rel.split('/')));
const pack = (code) => JSON.parse(read(`system/lang/${code}/pack.json`));
const lineCount = (s) => s.replace(/\n$/, '').split('\n').length;
const chars = (s) => [...s].length;

const NOTE_TYPES = ['decision', 'rule', 'procedure', 'fact', 'insight', 'project', 'proposal', 'analysis',
  'text', 'list', 'person', 'organization', 'journal'];

/** Lines from the kit:start line through the kit:end line, each ending with \n. */
function systemSection(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('<!-- kit:start'));
  const end = lines.findIndex((l) => l.includes('<!-- kit:end -->'));
  assert.ok(start >= 0 && end > start, 'kit markers');
  return `${lines.slice(start, end + 1).join('\n')}\n`;
}

/** The text without the lines from <!-- setup:start --> through <!-- setup:end -->. */
function withoutSetup(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('<!-- setup:start -->'));
  const end = lines.findIndex((l) => l.includes('<!-- setup:end -->'));
  if (start < 0 || end < start) return text;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

describe('AGENTS.md (9.1, 9.2)', () => {
  const agents = read('AGENTS.md');

  test('the system section without the setup block equals the English template byte for byte', () => {
    assert.ok(agents.includes('<!-- setup:start -->') && agents.includes('<!-- setup:end -->'), 'the kit ships the setup block');
    assert.equal(withoutSetup(systemSection(agents)), read('system/templates/en/kit/agents-system.md'));
  });

  test('budgets: whole file and system section', () => {
    assert.ok(lineCount(agents) <= 150 && chars(agents) <= 8000, `${lineCount(agents)} lines, ${chars(agents)} chars`);
    for (const lang of ['en', 'cs']) {
      const system = read(`system/templates/${lang}/kit/agents-system.md`);
      assert.ok(lineCount(system) <= 110, `${lang}: ${lineCount(system)} lines`);
      assert.ok(chars(system) <= 6000, `${lang}: ${chars(system)} chars`);
    }
  });

  test('the personal section follows the system section', () => {
    const after = agents.slice(agents.indexOf('<!-- kit:end -->'));
    assert.match(after, /\n## [^\n]+\n/);
    assert.equal(read('system/templates/en/kit/agents-personal.md').trim(), after.slice('<!-- kit:end -->'.length).trim());
  });

  for (const lang of ['en', 'cs']) {
    test(`${lang}: the search block has 10 numbered steps and fits 1600 bytes`, () => {
      const system = read(`system/templates/${lang}/kit/agents-system.md`);
      assert.ok(!system.includes('<!-- setup:start -->'), 'templates carry no setup block');
      const block = extractSearchBlock(system);
      assert.ok(block, 'search markers');
      assert.ok(Buffer.byteLength(block) <= 1600, `${Buffer.byteLength(block)} bytes`);
      const steps = block.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split('.')[0]));
      assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.ok(block.includes('node system/memory.mjs search'), 'canonical command');
    });
  }
});

describe('adapters (9.3 to 9.6)', () => {
  test('CLAUDE.md imports AGENTS.md and stays short', () => {
    const text = read('CLAUDE.md');
    assert.equal(text.split('\n').find((l) => l.trim() !== ''), '@AGENTS.md');
    assert.ok(lineCount(text) <= 25, `${lineCount(text)} lines`);
  });

  test('GEMINI.md is exactly the import', () => {
    assert.equal(read('GEMINI.md'), '@AGENTS.md\n');
  });

  test('the memory skill (open Agent Skills format)', () => {
    const skill = parse(read('.agents/skills/memory/SKILL.md'));
    assert.equal(skill.has, true);
    assert.equal(skill.data.name, 'memory');
    assert.ok(typeof skill.data.description === 'string' && skill.data.description.length <= 1024);
    assert.ok(lineCount(skill.body) <= 40, `${lineCount(skill.body)} body lines`);
    assert.ok(skill.body.includes('node system/memory.mjs start'));
  });

  test('Claude Code gets the same skill in .claude/skills/', () => {
    assert.equal(read('.claude/skills/memory/SKILL.md'), read('.agents/skills/memory/SKILL.md'));
  });

  test('the memory-searcher subagent', () => {
    const agent = parse(read('.claude/agents/memory-searcher.md'));
    assert.equal(agent.data.name, 'memory-searcher');
    assert.deepEqual(String(agent.data.tools).split(',').map((s) => s.trim()), ['Read', 'Grep', 'Glob', 'Bash']);
    assert.match(agent.body, /1500 tokens/);
  });

  test('the SessionStart hook prints the start file (shell form with a braced, quoted placeholder)', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    const entries = settings.hooks.SessionStart;
    const entry = entries.find((e) => e.matcher === 'startup|resume|clear|compact');
    assert.ok(entry, JSON.stringify(entries));
    // No `args` (exec form): Claude Code before 2.1.139 drops it and runs a bare `node` that reads
    // the hook input JSON as a script. The braces let Claude Code 2.1.198+ rewrite the placeholder
    // for PowerShell; sh, bash and Git Bash expand it on every version.
    assert.deepEqual(entry.hooks, [{
      type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start',
    }]);
  });

  test('the pre-commit hook runs the strict pre-commit check (it stages the generated views)', () => {
    const hook = read('.githooks/pre-commit');
    assert.ok(hook.startsWith('#!/bin/sh\n'));
    assert.ok(!hook.includes('\r'), 'LF only');
    assert.match(hook, /^"\$node_bin" system\/memory\.mjs check --pre-commit \|\| exit 1$/m);
    for (const place of ['git config --get memorykit.node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '.volta/bin/node', '$NVM_BIN/node']) {
      assert.ok(hook.includes(place), `looks for node in ${place}`);
    }
  });

  test('the pre-commit hook is executable', { skip: process.platform === 'win32' && 'no file modes on Windows' }, () => {
    const mode = fs.statSync(path.join(KIT_ROOT, '.githooks', 'pre-commit')).mode;
    assert.ok(mode & 0o111, `mode ${(mode & 0o777).toString(8)}; run: chmod 755 .githooks/pre-commit`);
  });
});

describe('templates (9.7)', () => {
  for (const lang of ['en', 'cs']) {
    const p = pack(lang);
    const key = (canon) => p.keys[canon];

    for (const type of NOTE_TYPES) {
      test(`${lang}: note template for ${type}`, () => {
        const rel = `system/templates/${lang}/notes/${p.types[type]}.md`;
        assert.ok(exists(rel), rel);
        const text = read(rel);
        const fm = parse(text);
        assert.equal(fm.has, true, rel);
        assert.deepEqual(fm.errors, [], rel);
        assert.equal(fm.data[key('type')], p.types[type]);
        assert.equal(fm.data[key('status')], p.statuses[type === 'journal' ? 'done' : 'active']);
        for (const k of ['description', 'updated']) assert.ok(Object.hasOwn(fm.data, key(k)), `${rel}: ${key(k)}`);
        if (type === 'decision' || type === 'journal') assert.ok(Object.hasOwn(fm.data, key('created')), `${rel}: ${key('created')}`);
        const placeholders = new Set([...text.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]));
        for (const ph of placeholders) assert.ok(['title', 'date'].includes(ph), `${rel}: {{${ph}}}`);
        assert.ok(text.includes('# {{title}}'), rel);
      });
    }

    test(`${lang}: no templates for sector and hub; kit templates present`, () => {
      assert.ok(!exists(`system/templates/${lang}/notes/${p.types.sector}.md`));
      assert.ok(!exists(`system/templates/${lang}/notes/${p.types.hub}.md`));
      for (const name of ['agents-system.md', 'agents-personal.md', 'state.md', 'waiting.md', 'profile.md', 'sector.md', 'export.md']) {
        assert.ok(exists(`system/templates/${lang}/kit/${name}`), `${lang}/kit/${name}`);
      }
      assert.ok(!exists(`system/templates/${lang}/kit/home.md`), 'the home page is generated');
      assert.ok(!read(`system/templates/${lang}/kit/sector.md`).includes('```'), 'no query blocks in manifests');
    });
  }
});

describe('editor-neutral git defaults (9.8)', () => {
  test('no editor settings are shipped', () => {
    assert.ok(!exists('.obsidian'), 'plain markdown; no editor folder in the kit');
  });

  test('.gitignore and .gitattributes', () => {
    const ignore = read('.gitignore').split('\n');
    for (const line of ['.env', '*.env', '*.pem', '*.key', '.obsidian/', '.vscode/', '.trash/', '.cache/', '.DS_Store', 'node_modules/']) {
      assert.ok(ignore.includes(line), line);
    }
    const attrs = read('.gitattributes');
    for (const line of ['* text=auto eol=lf', '_ai/** linguist-generated=true', '.ignore linguist-generated=true', 'home.md linguist-generated=true']) {
      assert.ok(attrs.includes(line), line);
    }
    assert.match(attrs, /system\/usage\/\*\.log merge=union/);
  });
});

describe('the kit is an empty, ready English vault (2.2)', () => {
  test('memory.json defaults', () => {
    const cfg = JSON.parse(read('memory.json'));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.initialized, false);
    assert.equal(cfg.lang, 'en');
    assert.equal(cfg.mode, 'github');
    assert.deepEqual(cfg.roots, [{ id: 'main', path: '.', privacy: 'github' }]);
    assert.deepEqual(cfg.cleanup, { provider: 'none' });
  });

  test('starter files', () => {
    for (const rel of ['home.md', 'state.md', 'waiting.md', 'sectors/core/_core.md', 'inbox/.gitkeep',
      'journal/.gitkeep', 'archive/.gitkeep', 'attachments/.gitkeep', 'system/tests/golden.json',
      'system/VERSION', 'LICENSE']) {
      assert.ok(exists(rel), rel);
    }
    assert.match(read('system/VERSION'), /^\d+\.\d+\.\d+\n$/);
  });

  test('a copy of the kit passes check --strict and start fits the hook budget', () => {
    const root = copyKit(path.join(tmpDir('kit'), 'memory-kit'));
    const res = checkJson(root, ['--strict']);
    assert.equal(res.code, 0, describeFindings(res));
    const start = runCli(root, ['start']);
    assert.equal(start.code, 0);
    assert.ok(Buffer.byteLength(start.stdout) <= 9500, `${Buffer.byteLength(start.stdout)} bytes`);
    assert.ok(start.stdout.startsWith('Memory is not set up yet.'), start.stdout.slice(0, 200));
  });
});
