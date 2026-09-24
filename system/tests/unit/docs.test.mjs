// Commands shown to people run the same in bash, zsh and PowerShell (README, "Windows, macOS or
// Linux"). PowerShell on Windows before 7.6 (so the built-in Windows PowerShell 5.1) and cmd hand
// a `~` to programs unchanged, and node then looks for a folder named `~` next to the current one
// ("Cannot find module …/~/my-memory/system/memory.mjs"). So no command passes a `~` path to node.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../helpers.mjs';

// Kit files that show commands to people. Missing ones are skipped: a vault may have no docs/.
const FILES = ['.agents/skills/memory/SKILL.md', '.claude/skills/memory/SKILL.md', '.claude/agents/memory-searcher.md'];
// The kit's own README, contributing guide and changelog. In a vault that is set up they are the
// owner's files (an upgrade never touches them), so only the kit itself is held to this.
const KIT_ONLY = ['README.md', 'README.cs.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
const MD_DIRS = ['docs', 'system/templates'];
const LANG_DIR = 'system/lang';
const CLAUDE_CODE_GUIDE = 'docs/integrations/claude-code.md';

// `node ~/…`, `node.exe ~\…`, `node --flag "~/…"`: the script path starts with a `~`.
const NODE_TILDE = /\bnode(?:\.exe)?(?:\s+--?[\w-]+(?:=\S*)?)*\s+["']?~(?=[\\/\s"'`]|$)/;

const abs = (rel) => path.join(KIT_ROOT, ...rel.split('/'));

/** True in the kit itself: its memory.json is not set up (a vault's is). */
function isKitItself() {
  try {
    return JSON.parse(fs.readFileSync(abs('memory.json'), 'utf8')).initialized !== true;
  } catch {
    return true;
  }
}

/** POSIX rels of the markdown files under a kit-relative folder, sorted. */
function markdownUnder(rel) {
  if (!fs.existsSync(abs(rel))) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs(rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...markdownUnder(child));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
  }
  return out.sort();
}

/** Every existing kit file that shows commands to people, including the language packs. */
function commandFiles() {
  const packs = fs.existsSync(abs(LANG_DIR))
    ? fs.readdirSync(abs(LANG_DIR)).map((code) => `${LANG_DIR}/${code}/pack.json`)
    : [];
  const own = isKitItself() ? KIT_ONLY : [];
  return [...own, ...FILES, ...MD_DIRS.flatMap(markdownUnder), ...packs].filter((rel) => fs.existsSync(abs(rel)));
}

/** `rel:line: text` for each line that passes a `~` path to node. */
function tildeCommands(rel) {
  const lines = fs.readFileSync(abs(rel), 'utf8').split(/\r?\n/);
  return lines.flatMap((line, i) => (NODE_TILDE.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : []));
}

describe('commands in the docs work in every supported shell', () => {
  test('the pattern finds a ~ path handed to node and nothing else', () => {
    for (const bad of [
      '**Or through MCP, in every project at once:** `node ~/my-memory/system/memory.mjs connect claude-code`',
      '`node ~/my-memory/system/memory.mjs …` works from any working directory',
      '2. Run `node ~/my-memory/system/memory.mjs start` and follow its output',
      'node ~\\my-memory\\system\\memory.mjs start',
      'node.exe "~/my-memory/system/memory.mjs" start',
      'node --no-warnings ~/my-memory/system/memory.mjs search "x"',
    ]) assert.match(bad, NODE_TILDE, bad);
    for (const good of [
      'node system/memory.mjs connect claude-code',
      'node C:/Users/you/my-memory/system/memory.mjs start',
      'node /Users/you/my-memory/system/memory.mjs start',
      'node ../kit-try/system/memory.mjs hledej "práce"',
      'cd ~/my-memory',
      'Start Claude Code with the extra directory: `claude --add-dir ~/my-memory`.',
      'It adds a `memory-kit` entry to `~/.cursor/mcp.json`',
      'node reports "Cannot find module" with a `~` folder in the path',
    ]) assert.doesNotMatch(good, NODE_TILDE, good);
  });

  test('no command passes a ~ path to node (Windows PowerShell 5.1 and cmd do not expand it)', () => {
    const files = commandFiles();
    if (isKitItself()) assert.ok(files.includes('README.md'), 'the scan reaches the README');
    assert.ok(files.includes('system/lang/cs/pack.json'), 'the scan reaches the language packs');
    assert.deepEqual(files.flatMap(tildeCommands), []);
  });

  test('the Claude Code guide connects MCP from inside the memory folder, one command per line',
    { skip: !fs.existsSync(abs(CLAUDE_CODE_GUIDE)) && 'this vault has no docs/' }, () => {
      const text = fs.readFileSync(abs(CLAUDE_CODE_GUIDE), 'utf8').replace(/\r\n/g, '\n');
      assert.match(text, /^```sh\ncd ~\/my-memory\nnode system\/memory\.mjs connect claude-code\n```$/m);
    });
});
