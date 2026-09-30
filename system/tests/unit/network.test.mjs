// The kit never talks to the network by itself (docs/architecture.md, 1.1), and this test is the
// proof the README points to. Every module of the kit (system/, tests aside) imports only its own
// files and the built-ins listed below, none of which opens a connection; no module calls a
// network API of the runtime or starts a download tool; and git reaches a remote only where the
// owner asks for it: `sync` pulls and pushes the vault's own remote (autosync, when turned on,
// runs sync), `upgrade` makes a shallow clone of the kit source, and the update check reads the
// kit's version tags (`upgrade --check`, and once a day only with "updates": {"check": true}).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../helpers.mjs';

const ALLOWED_BUILTINS = new Set([
  'node:buffer', 'node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:perf_hooks',
  'node:readline', 'node:sqlite', 'node:url', 'node:util',
]);
// The built-ins that open sockets, bare or with the node: prefix.
const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'inspector', 'cluster'];
const NETWORK_APIS = [/\bfetch\s*\(/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bEventSource\b/, /\bsendBeacon\b/];
const DOWNLOAD_TOOLS = [/['"](curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|bitsadmin|certutil)['"]/i];
// git subcommands that reach a remote, and the only modules that may run them.
const GIT_REMOTE = /\[\s*'(clone|pull|push|fetch|ls-remote)'/g;
const GIT_ALLOWED = {
  'system/lib/upgrade.mjs': ['clone'],
  'system/lib/updates.mjs': ['ls-remote'],
  'system/lib/commands/sync.mjs': ['pull', 'push'],
};

/** Every .mjs file of the kit's code (system/, without its tests), as vault-relative paths. */
function kitModules(dir = path.join(KIT_ROOT, 'system'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(KIT_ROOT, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (rel !== 'system/tests') kitModules(abs, out);
    } else if (entry.name.endsWith('.mjs')) {
      out.push(rel);
    }
  }
  return out.sort();
}

const read = (rel) => fs.readFileSync(path.join(KIT_ROOT, ...rel.split('/')), 'utf8');
/** The code without whole-line and block comments (which name URLs and tools in prose). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

/** The literal module specifiers of a file: static imports and re-exports, and import('…'). */
function specifiers(text) {
  const out = [];
  const statement = /^(?:import|export)\s(?:[^'";]|\n)*?\sfrom\s*['"]([^'"]+)['"]/gm;
  for (const re of [statement, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s*['"]([^'"]+)['"]/gm]) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

describe('no network (1.1)', () => {
  const modules = kitModules();

  test('the scan sees the whole kit', () => {
    assert.ok(modules.length >= 50, `${modules.length} modules`);
    for (const rel of ['system/memory.mjs', 'system/api.mjs', 'system/lib/mcp.mjs', 'system/lib/activity.mjs', 'system/lib/commands/activity.mjs']) {
      assert.ok(modules.includes(rel), rel);
    }
  });

  test('every import is a kit file or a built-in that opens no connection', () => {
    const bad = [];
    for (const rel of modules) {
      for (const spec of specifiers(code(read(rel)))) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        const bare = spec.replace(/^node:/, '').split('/')[0];
        if (NETWORK_MODULES.includes(bare) || !ALLOWED_BUILTINS.has(spec)) bad.push(`${rel}: ${spec}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('no network API of the runtime and no download tool', () => {
    const bad = [];
    for (const rel of modules) {
      const text = code(read(rel));
      for (const re of [...NETWORK_APIS, ...DOWNLOAD_TOOLS]) if (re.test(text)) bad.push(`${rel}: ${re}`);
    }
    assert.deepEqual(bad, []);
  });

  test('git reaches a remote only in sync (pull, push), upgrade (clone) and the update check (ls-remote)', () => {
    const found = {};
    for (const rel of modules) {
      for (const m of code(read(rel)).matchAll(GIT_REMOTE)) (found[rel] ??= []).push(m[1]);
    }
    for (const rel of Object.keys(found)) found[rel] = [...new Set(found[rel])].sort();
    assert.deepEqual(found, GIT_ALLOWED);
  });

  test('the scan would notice: a module that fetches or imports https is caught', () => {
    const sample = "import https from 'node:https';\nconst r = await fetch('https://example.com');\n";
    assert.deepEqual(specifiers(code(sample)), ['node:https']);
    assert.deepEqual(specifiers("import {\n  a,\n  b,\n} from '../x.mjs';\nexport { c } from './c.mjs';\nconst y = values.from;\n"), ['../x.mjs', './c.mjs']);
    assert.ok(NETWORK_APIS[0].test(code(sample)));
    assert.deepEqual(specifiers(code("// import x from 'node:net'\n/* fetch(url) */\n")), []);
  });
});
