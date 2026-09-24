// The MCP server over raw pipes: `node system/memory.mjs mcp --root <vault>` is driven like a
// client would drive it (docs/maintenance.md, MCP server): the initialize handshake of every
// accepted protocol version, tool lists per version, every tool with good and bad arguments,
// path traversal attempts, inbox writes, --read-only, --local, framing (CRLF, a UTF-8 character
// split across two writes, a last line without newline), batches, the 2026-07-28 era, and a clean
// exit when stdin ends. Every stdout line must be a JSON-RPC message. The protocol engine is also
// tested in-process with injected streams (cancellation, the size cap, a broken vault).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  ERRORS, FALLBACK_VERSION, INSTRUCTIONS, LEGACY_VERSIONS, MODERN_VERSIONS, createServer, serveStdio,
} from '../../lib/mcp.mjs';
import {
  KIT_ROOT, fixtureVault, plantSecret, readFile, removeTmpDirs, runCli, tmpDir, writeFile, writeJson,
} from '../helpers.mjs';

// Servers still running after the tests (a test failed before its close()) are killed, so a
// failure can never leave the test process waiting on their pipes.
const running = new Set();
after(() => {
  for (const child of running) child.kill();
  running.clear();
});
after(removeTmpDirs);

const VERSION = fs.readFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), 'utf8').trim();
const TOOLS = ['memory_start', 'memory_search', 'memory_read', 'memory_recent', 'memory_inbox'];
const PRIVATE_TEXT = '5 km each'; // only in the local root's running plan
const WAIT_MS = 15000;
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
};

// Variables that would change what the server does.
const SCRUBBED_ENV = ['MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throws unless one decoded stdout line is a JSON-RPC response (or a batch of them). */
function assertJsonRpcLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    throw new Error(`stdout line is not JSON: ${JSON.stringify(line)} (${err.message})`);
  }
  const list = Array.isArray(msg) ? msg : [msg];
  assert.ok(list.length > 0, 'an empty batch response');
  for (const m of list) {
    assert.ok(m && typeof m === 'object' && !Array.isArray(m), line);
    assert.equal(m.jsonrpc, '2.0', line);
    assert.ok(('result' in m) !== ('error' in m), `exactly one of result and error: ${line}`);
    if ('id' in m) assert.ok(typeof m.id === 'string' || Number.isInteger(m.id), `id must be a string or an integer: ${line}`);
    else assert.ok('error' in m, `a result needs its id: ${line}`);
    if ('error' in m) {
      assert.ok(Number.isInteger(m.error.code), line);
      assert.equal(typeof m.error.message, 'string', line);
    }
    assert.ok(!('method' in m), `the server never sends requests or notifications: ${line}`);
  }
  return msg;
}

/** A server process driven over pipes; every stdout line is checked as it arrives. */
class Client {
  constructor(root, args = [], { env = {} } = {}) {
    const childEnv = { ...process.env };
    for (const key of SCRUBBED_ENV) delete childEnv[key];
    this.child = spawn(process.execPath, [path.join(root, 'system', 'memory.mjs'), 'mcp', '--root', root, ...args], {
      cwd: root,
      env: { ...childEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.messages = [];
    this.lines = [];
    this.stderr = '';
    this.nextId = 1;
    this.waiters = new Set();
    let pending = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, nl).toString('utf8');
        pending = pending.subarray(nl + 1);
        this.lines.push(line);
        this.messages.push(assertJsonRpcLine(line));
        for (const w of [...this.waiters]) w();
      }
    });
    this.child.stdout.on('end', () => {
      this.tail = pending.toString('utf8');
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    running.add(this.child);
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        running.delete(this.child);
        resolve({ code, signal });
      });
    });
  }

  writeRaw(data) {
    this.child.stdin.write(data);
  }

  send(msg) {
    this.writeRaw(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  }

  /** The first message (index >= from) matching pred; waits for it. */
  next(pred, { from = 0, label = 'a message' } = {}) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.messages.findIndex((m, k) => k >= from && pred(m));
        if (i < 0) return false;
        cleanup();
        resolve(this.messages[i]);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${label}; stdout:\n${this.lines.join('\n')}\nstderr:\n${this.stderr}`));
      }, WAIT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      if (!check()) this.waiters.add(check);
    });
  }

  async request(method, params, { id = this.nextId++ } = {}) {
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
    return this.next((m) => !Array.isArray(m) && m.id === id, { label: `the response to ${method} #${id}` });
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  async initialize(protocolVersion = '2025-11-25') {
    const res = await this.request('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return res;
  }

  /** tools/call; returns the result object (throws on a JSON-RPC error). */
  async call(name, args, extra = {}) {
    const res = await this.request('tools/call', { name, arguments: args, ...extra });
    assert.ok(res.result, `tools/call ${name} failed: ${JSON.stringify(res)}`);
    return res.result;
  }

  /** Ends stdin and waits for the exit; asserts a clean exit 0 and nothing half-written. */
  async close() {
    this.child.stdin.end();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), WAIT_MS);
    });
    const exit = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    if (!exit) {
      this.child.kill();
      throw new Error(`the server did not exit after stdin ended; stderr:\n${this.stderr}`);
    }
    assert.equal(exit.code, 0, `exit ${exit.code} ${exit.signal ?? ''}\n${this.stderr}`);
    assert.equal(this.tail ?? '', '', 'stdout ends with a complete line');
    return exit;
  }
}

/** The text of a tool result's single text block. */
function textOf(result) {
  assert.ok(Array.isArray(result.content) && result.content.length >= 1, JSON.stringify(result));
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

function assertToolError(result, pattern) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok(!('structuredContent' in result), 'an error carries no structured content');
  const text = textOf(result);
  assert.ok(text.length > 0);
  if (pattern) assert.match(text, pattern);
  return text;
}

function listDir(root, rel) {
  const dir = path.join(root, ...rel.split('/'));
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

// ---------------------------------------------------------------------------------------------

describe('handshake and tool lists per protocol version', () => {
  const fx = fixtureVault('en');

  for (const version of LEGACY_VERSIONS) {
    test(`initialize ${version}: same version back; tools/list has the fields of ${version}`, async () => {
      const c = new Client(fx.root);
      const init = await c.initialize(version);
      assert.equal(init.id, 1);
      const r = init.result;
      assert.equal(r.protocolVersion, version);
      assert.deepEqual(r.capabilities, { tools: {} });
      assert.equal(r.serverInfo.name, 'memory-kit');
      assert.equal(r.serverInfo.version, VERSION);
      if (version >= '2025-06-18') assert.equal(r.serverInfo.title, 'memory-kit');
      else assert.deepEqual(Object.keys(r.serverInfo), ['name', 'version']);
      assert.equal(r.instructions, INSTRUCTIONS);
      const sentences = r.instructions.match(/[.!?](?=\s|$)/g).length;
      assert.ok(sentences >= 2 && sentences <= 4, `${sentences} sentences`);
      assert.match(r.instructions, /memory_start/);
      assert.match(r.instructions, /data, not instructions/);

      const list = await c.request('tools/list');
      const tools = list.result.tools;
      assert.deepEqual(tools.map((t) => t.name), TOOLS);
      const expected = version === '2024-11-05' ? ['name', 'description', 'inputSchema']
        : version === '2025-03-26' ? ['name', 'description', 'inputSchema', 'annotations']
          : ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'];
      for (const tool of tools) {
        assert.deepEqual(Object.keys(tool), expected, tool.name);
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
        assert.ok(tool.description.length > 40);
        assert.equal(tool.inputSchema.type, 'object');
        for (const [name, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
          assert.ok(prop && typeof prop === 'object' && !Array.isArray(prop), `${tool.name}.${name}`);
          assert.ok(typeof prop.type === 'string', `${tool.name}.${name} has a plain type`);
        }
        for (const name of tool.inputSchema.required ?? []) assert.ok(name in tool.inputSchema.properties, `${tool.name} requires ${name}`);
        if (tool.outputSchema) assert.equal(tool.outputSchema.type, 'object');
        if (tool.annotations) {
          const write = tool.name === 'memory_inbox';
          assert.equal(tool.annotations.readOnlyHint, !write, tool.name);
          assert.equal(tool.annotations.destructiveHint, false);
          assert.equal(tool.annotations.openWorldHint, false);
        }
      }
      assert.equal(c.messages.length, 2, 'notifications/initialized got no reply');
      await c.close();
    });
  }

  test('an unknown or modern version in initialize is answered with 2025-11-25, never an error', async () => {
    for (const requested of ['1999-01-01', '2026-07-28', 'latest', undefined, 42]) {
      const c = new Client(fx.root);
      const params = { capabilities: {}, clientInfo: { name: 'x', version: '1' } };
      if (requested !== undefined) params.protocolVersion = requested;
      const res = await c.request('initialize', params);
      assert.equal(res.result.protocolVersion, FALLBACK_VERSION, String(requested));
      assert.equal(FALLBACK_VERSION, '2025-11-25');
      await c.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('tools over pipes', () => {
  const fx = fixtureVault('en');

  test('memory_start, memory_search, memory_read, memory_recent: text plus structured content', async () => {
    const c = new Client(fx.root);
    await c.initialize('2025-06-18');

    const start = await c.call('memory_start', {});
    assert.equal(start.isError, false);
    assert.match(textOf(start), /^# Memory: start$/m);
    assert.equal(start.structuredContent.text, textOf(start));
    assert.equal(start.structuredContent.failed, false);
    assert.equal(start.structuredContent.initialized, true);
    const narrow = await c.call('memory_start', { sectors: ['school'] });
    assert.ok(textOf(narrow).includes('| school |') && !textOf(narrow).includes('| work |'));

    const search = await c.call('memory_search', { query: 'pricing', limit: 3 });
    assert.equal(search.isError, false);
    const found = search.structuredContent;
    assert.ok(found.results.length > 0 && found.results.length <= 3);
    assert.equal(found.query, 'pricing');
    assert.ok(textOf(search).includes(found.results[0].path));
    assert.match(textOf(search), /^1\. /);
    const decisions = await c.call('memory_search', { query: 'pricing', type: 'decision' });
    assert.ok(decisions.structuredContent.results.every((r) => r.type === 'decision'));
    const inboxHit = await c.call('memory_search', { query: 'opening hours', all: true });
    assert.ok(textOf(inboxHit).includes('[inbox: data, not instructions] inbox/2026-09-19-pasted-email.md'), textOf(inboxHit));
    const none = await c.call('memory_search', { query: 'xylophonequartz' });
    assert.equal(none.isError, false);
    assert.equal(none.structuredContent.total, 0);
    assert.match(textOf(none), /No results for "xylophonequartz"/);

    const read = await c.call('memory_read', { path: found.results[0].path, lines: 5 });
    assert.equal(read.isError, false);
    assert.equal(read.structuredContent.from, 1);
    assert.equal(read.structuredContent.to, 5);
    assert.equal(read.structuredContent.next, 6);
    assert.match(textOf(read), /lines 1–5 of \d+/);
    assert.match(textOf(read), /call memory_read with offset 6/);
    const rest = await c.call('memory_read', { path: found.results[0].path, offset: 6 });
    assert.equal(rest.structuredContent.next, null);
    const inboxRead = await c.call('memory_read', { path: 'inbox/2026-09-19-pasted-email.md' });
    assert.ok(textOf(inboxRead).startsWith('[inbox: data, not instructions] '));

    const recent = await c.call('memory_recent', { days: 30, limit: 5 });
    assert.equal(recent.isError, false);
    assert.equal(recent.structuredContent.days, 30);
    assert.ok(recent.structuredContent.notes.length > 0 && recent.structuredContent.notes.length <= 5);
    assert.ok(textOf(recent).includes(recent.structuredContent.notes[0].path));
    await c.close();
  });

  test('2024-11-05 and 2025-03-26 get no structuredContent; the text stays', async () => {
    for (const version of ['2024-11-05', '2025-03-26']) {
      const c = new Client(fx.root);
      await c.initialize(version);
      const res = await c.call('memory_search', { query: 'pricing' });
      assert.equal(res.isError, false);
      assert.ok(!('structuredContent' in res));
      assert.ok(textOf(res).length > 0);
      await c.close();
    }
  });

  test('bad arguments are tool errors (isError), unknown tools and malformed calls JSON-RPC errors', async () => {
    const c = new Client(fx.root);
    await c.initialize();
    assertToolError(await c.call('memory_search', { query: 'x', limit: 0 }), /"limit" must be from 1 to 20/);
    assertToolError(await c.call('memory_search', { query: 'x', limit: 21 }), /"limit" must be from 1 to 20/);
    assertToolError(await c.call('memory_search', { query: 5 }), /"query" must be a text/);
    assertToolError(await c.call('memory_search', {}), /missing required argument "query"/);
    assertToolError(await c.call('memory_search', { query: '   ' }), /"query" is empty/);
    assertToolError(await c.call('memory_search', { query: 'x', n: 3 }), /unknown argument "n"; allowed: query, sector, type, status, limit, all/);
    assertToolError(await c.call('memory_search', { query: 'x', sector: 'nope' }), /unknown sector "nope"/);
    assertToolError(await c.call('memory_search', { query: 'x', type: 'poem' }), /unknown type "poem"/);
    assertToolError(await c.call('memory_search', { query: 'x', all: 'maybe' }), /"all" must be true or false/);
    assertToolError(await c.call('memory_search', { query: 'q'.repeat(501) }), /longer than 500/);
    assertToolError(await c.call('memory_read', { path: 'sectors/work/pricing.md', lines: 401 }), /from 1 to 400/);
    assertToolError(await c.call('memory_read', { path: 'sectors/work/pricing.md', offset: 999 }), /past the end/);
    assertToolError(await c.call('memory_recent', { days: 366 }), /"days" must be from 0 to 365/);
    assertToolError(await c.call('memory_start', { sectors: 'school', extra: 1 }), /unknown argument "extra"/);
    // Numbers and booleans sent as text are accepted.
    const lenient = await c.call('memory_search', { query: 'pricing', limit: '2', all: 'false' });
    assert.equal(lenient.isError, false);
    assert.ok(lenient.structuredContent.results.length <= 2);
    // No arguments at all is fine for tools without required ones.
    assert.equal((await c.request('tools/call', { name: 'memory_recent' })).result.isError, false);

    const unknown = await c.request('tools/call', { name: 'memory_delete', arguments: {} });
    assert.equal(unknown.error.code, ERRORS.INVALID_PARAMS);
    assert.match(unknown.error.message, /Unknown tool: memory_delete/);
    assert.equal((await c.request('tools/call', { arguments: {} })).error.code, ERRORS.INVALID_PARAMS);
    assert.equal((await c.request('tools/call', { name: 'memory_search', arguments: ['pricing'] })).error.code, ERRORS.INVALID_PARAMS);
    assert.equal((await c.request('tools/call', { name: 'memory_search', arguments: 'pricing' })).error.code, ERRORS.INVALID_PARAMS);
    await c.close();
  });

  test('memory_read refuses traversal, absolute paths, drive letters, backslashes, .git, system/ and local notes', async () => {
    const v = fixtureVault('en');
    writeFile(v.root, '.git/config.md', '# not a note\n');
    writeFile(v.root, 'sectors/health/leaked-notes.md', `# Leaked\n${PRIVATE_TEXT}\n`);
    const c = new Client(v.root);
    await c.initialize();
    const absolute = `${v.root.split(path.sep).join('/')}/sectors/work/pricing.md`;
    const attempts = [
      '../private/sectors/health/running-plan.md',
      'sectors/../../private/sectors/health/running-plan.md',
      '..%2fprivate/sectors/health/running-plan.md',
      '/etc/passwd',
      absolute,
      v.root + path.sep + 'AGENTS.md',
      'C:/Windows/win.ini',
      'C:\\Windows\\win.ini',
      'sectors\\work\\pricing.md',
      '.git/config',
      '.git/config.md',
      'system/lib/config.mjs',
      'system/tests/fixtures/en/vault/state.md',
      'SYSTEM/tests/fixtures/en/vault/state.md',
      'memory.json',
      'sectors/health/running-plan.md',
      'sectors/health/leaked-notes.md',
      '~/.ssh/id_rsa.md',
    ];
    for (const attempt of attempts) {
      const res = await c.call('memory_read', { path: attempt });
      const text = assertToolError(res);
      assert.ok(!text.includes(PRIVATE_TEXT), attempt);
    }
    // The legitimate neighbours still work.
    assert.equal((await c.call('memory_read', { path: 'sectors/work/pricing.md' })).isError, false);
    assert.equal((await c.call('memory_read', { path: 'sectors/health/_health-export.md' })).isError, false);
    for (const line of c.lines) assert.ok(!line.includes(PRIVATE_TEXT), 'no private text on stdout');
    await c.close();
  });

  test('memory_inbox writes exactly one new file, never overwrites, refuses secrets', async () => {
    const v = fixtureVault('en');
    const before = listDir(v.root, 'inbox');
    const c = new Client(v.root);
    await c.initialize();
    const res = await c.call('memory_inbox', { text: 'Idea: a loyalty card for bakery customers.', title: 'Loyalty card', source: 'a call' });
    assert.equal(res.isError, false, textOf(res));
    const saved = res.structuredContent.path;
    assert.match(saved, /^inbox\/\d{4}-\d{2}-\d{2}-loyalty-card\.md$/);
    assert.match(textOf(res), /^Saved to inbox\/.*loyalty-card\.md\. It stays in the inbox until the owner files it\.$/);
    const afterOne = listDir(v.root, 'inbox');
    const added = Object.keys(afterOne).filter((name) => !(name in before));
    assert.deepEqual(added, [path.posix.basename(saved)]);
    for (const [name, text] of Object.entries(before)) assert.equal(afterOne[name], text, `${name} unchanged`);
    assert.match(readFile(v.root, saved), /^---\ncreated: \d{4}-\d{2}-\d{2}\nsource: a call\n---\n# Loyalty card\n\nIdea: a loyalty card for bakery customers\.\n$/);

    const again = await c.call('memory_inbox', { text: 'A second, different capture.', title: 'Loyalty card' });
    assert.equal(again.structuredContent.path, saved.replace(/\.md$/, '-2.md'));
    assert.equal(readFile(v.root, saved), afterOne[path.posix.basename(saved)], 'the first file is untouched');
    assert.match(readFile(v.root, again.structuredContent.path), /^---\ncreated: .*\nsource: test-client \(mcp\)\n---\n/);

    const count = Object.keys(listDir(v.root, 'inbox')).length;
    const secret = await c.call('memory_inbox', { text: `the deploy token is ${plantSecret().github}` });
    const text = assertToolError(secret, /secret/);
    assert.ok(!text.includes(plantSecret().github));
    assertToolError(await c.call('memory_inbox', { text: 'x'.repeat(20001) }), /longer than 20000/);
    assertToolError(await c.call('memory_inbox', {}), /missing required argument "text"/);
    assert.equal(Object.keys(listDir(v.root, 'inbox')).length, count, 'refused captures write nothing');
    await c.close();
  });

  test('--read-only: no memory_inbox in the list, a call to it is refused, nothing is written', async () => {
    const v = fixtureVault('en');
    const before = listDir(v.root, 'inbox');
    const c = new Client(v.root, ['--read-only']);
    const init = await c.initialize('2025-06-18');
    assert.ok(!init.result.instructions.includes('memory_inbox'), 'no word about a tool it does not offer');
    assert.ok(INSTRUCTIONS.startsWith(init.result.instructions));
    const list = await c.request('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.filter((t) => t !== 'memory_inbox'));
    assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint === true));
    const res = await c.request('tools/call', { name: 'memory_inbox', arguments: { text: 'should not land' } });
    assert.equal(res.error.code, ERRORS.INVALID_PARAMS);
    assert.deepEqual(listDir(v.root, 'inbox'), before);
    assert.match(c.stderr, /read-only/);
    await c.close();
  });

  test('local notes stay hidden without --local and are served with it', async () => {
    const v = fixtureVault('en');
    const hidden = new Client(v.root);
    await hidden.initialize();
    const res = await hidden.call('memory_search', { query: 'running plan' });
    assert.ok(res.structuredContent.results.every((r) => !r.local));
    assert.ok(res.structuredContent.localHits >= 1);
    assert.match(textOf(res), /matches in local sectors are not shown: this server runs without --local/);
    assertToolError(await hidden.call('memory_read', { path: 'sectors/health/running-plan.md' }), /no readable note/);
    for (const line of hidden.lines) assert.ok(!line.includes(PRIVATE_TEXT));
    await hidden.close();

    const shown = new Client(v.root, ['--local']);
    await shown.initialize();
    const res2 = await shown.call('memory_search', { query: 'running plan' });
    const hit = res2.structuredContent.results.find((r) => r.local);
    assert.ok(hit, JSON.stringify(res2.structuredContent));
    // The text names the path memory_read takes; the structured path (from the vault root) works too.
    assert.ok(textOf(res2).includes('[L] sectors/health/running-plan.md'), textOf(res2));
    assert.equal(hit.path, '../private/sectors/health/running-plan.md');
    for (const shownPath of [hit.rel, hit.path]) {
      const read = await shown.call('memory_read', { path: shownPath });
      assert.equal(read.isError, false, textOf(read));
      assert.equal(read.structuredContent.root, 'private');
      assert.ok(textOf(read).startsWith('[L] '));
      assert.ok(textOf(read).includes(PRIVATE_TEXT));
    }
    // Every hit is readable by the path its text line shows.
    const every = await shown.call('memory_search', { query: 'dentist appointments', all: true, limit: 20 });
    const rows = textOf(every).split('\n').filter((l) => /^\d+\. /.test(l));
    assert.ok(rows.some((l) => l.includes('[L] ')), textOf(every));
    for (const row of rows) {
      const rowPath = row.replace(/^\d+\. /, '').split(' · ')[0].replace(/^(?:\[[^\]]*\] )+/, '');
      assert.equal((await shown.call('memory_read', { path: rowPath, lines: 1 })).isError, false, rowPath);
    }
    // Only the exact local root prefix leads out of the vault; traversal around it stays refused.
    for (const attempt of [
      '../private/../private/sectors/health/running-plan.md',
      '../private/sectors/../../vault/sectors/work/pricing.md',
      '../privateX/sectors/health/running-plan.md',
      '../Private/sectors/health/running-plan.md',
      'sectors/../../private/sectors/health/running-plan.md',
    ]) {
      assertToolError(await shown.call('memory_read', { path: attempt }));
    }
    await shown.close();
  });

  test('private content left in a local sector\'s main-root folder never leaves: search, start, recent, the log', async () => {
    const v = fixtureVault('en');
    const secrets = ['Diagnosed with chronic', 'Neurologist confirmed', 'Old insulin dose', 'insulin 10 units'];
    writeJson(v.root, 'memory.json', { ...JSON.parse(readFile(v.root, 'memory.json')), search: { log: true, n: 5 } });
    writeFile(v.root, 'sectors/health/leaked-diagnosis.md', [
      '---', 'type: fact', 'status: active', 'updated: 2026-09-18',
      'description: Diagnosed with chronic migraine in March, takes sumatriptan.', '---', '# Diagnosis', '',
      '- [fact] 2026-03-02: Neurologist confirmed chronic migraine; prescribed sumatriptan 50 mg.', '',
    ].join('\n'));
    writeFile(v.root, 'archive/sectors/health/old-leak.md', [
      '---', 'type: fact', 'status: done', 'updated: 2026-01-10', 'description: Old insulin dose.', '---', '# Old dose', '',
      '- insulin 10 units', '',
    ].join('\n'));
    // A committed _ai/start.md that is fresh must not bring them back either.
    runCli(v.root, ['check', '--generate']);
    for (const args of [[], ['--local']]) {
      const c = new Client(v.root, args);
      await c.initialize();
      for (const [query, all] of [['migraine sumatriptan', false], ['migraine sumatriptan', true], ['insulin', true]]) {
        const res = await c.call('memory_search', { query, all });
        assert.equal(res.isError, false, textOf(res));
        const found = res.structuredContent;
        assert.ok(found.results.every((r) => !/leak/.test(r.rel)), JSON.stringify(found.results));
        if (!args.length) assert.ok(found.localHits >= 1, `${query}: only counted`);
      }
      const start = await c.call('memory_start', {});
      assert.ok(textOf(start).includes('LOCAL_IN_GIT sectors/health/leaked-diagnosis.md'), 'the alert names the path only');
      assert.ok(!textOf(start).includes('- sectors/health/leaked-diagnosis.md'), 'not a hot note');
      await c.call('memory_start', { sectors: ['health'] });
      await c.call('memory_recent', { days: 365, limit: 50 });
      assertToolError(await c.call('memory_read', { path: 'sectors/health/leaked-diagnosis.md' }));
      assertToolError(await c.call('memory_read', { path: 'archive/sectors/health/old-leak.md' }));
      for (const line of c.lines) {
        for (const secret of secrets) assert.ok(!line.includes(secret), `${args.join(' ')}: "${secret}" left the server`);
      }
      await c.close();
    }
    const log = readFile(v.root, 'system/usage/search.log');
    assert.ok(log.includes('\tmigraine sumatriptan\t'), log);
    assert.ok(!log.includes('leak'), `the committed search log names no private note:\n${log}`);
  });

  test('without --local an unknown-sector error names no sector that only a local root holds', async () => {
    const v = fixtureVault('en');
    writeFile(v.priv, 'sectors/divorce-lawyer/filing.md', '---\ntype: fact\nstatus: active\nupdated: 2026-09-10\ndescription: Court hearing date.\n---\n# Filing\n\nThe hearing is in October.\n');
    const hidden = new Client(v.root);
    await hidden.initialize();
    const text = assertToolError(await hidden.call('memory_search', { query: 'hearing', sector: 'x' }), /unknown sector "x"; sectors: core, health, hobbies, school, work$/);
    assert.ok(!text.includes('divorce'));
    assertToolError(await hidden.call('memory_search', { query: 'hearing', sector: 'divorce-lawyer' }), /unknown sector "divorce-lawyer"/);
    assert.equal((await hidden.call('memory_search', { query: 'hearing' })).structuredContent.localHits, 1);
    for (const line of hidden.lines) assert.ok(!line.includes('divorce-lawyer/') && !line.includes('sectors: core, divorce'), line);
    await hidden.close();
    const shown = new Client(v.root, ['--local']);
    await shown.initialize();
    assertToolError(await shown.call('memory_search', { query: 'hearing', sector: 'x' }), /sectors: core, divorce-lawyer, health/);
    const found = await shown.call('memory_search', { query: 'hearing', sector: 'divorce-lawyer' });
    assert.equal(found.structuredContent.results[0].rel, 'sectors/divorce-lawyer/filing.md');
    await shown.close();
  });

  test('memory_start gives the search rules of the tools, not shell commands', async () => {
    for (const lang of ['en', 'cs']) {
      const v = lang === 'en' ? fx : fixtureVault('cs');
      const c = new Client(v.root);
      await c.initialize();
      for (const args of [{}, { sectors: ['school'] }]) {
        const text = textOf(await c.call('memory_start', args));
        for (const tool of ['memory_search', 'memory_read', 'all: true']) assert.ok(text.includes(tool), `${lang}: ${tool}`);
        for (const shell of ['node system/memory.mjs search', 'rg -i', 'rg -il', 'git log', 'memory-searcher', 'Read with limit']) {
          assert.ok(!text.includes(shell), `${lang}: ${shell}`);
        }
      }
      await c.close();
      // The CLI start keeps the protocol of AGENTS.md.
      assert.ok(runCli(v.root, ['start']).stdout.includes('node system/memory.mjs search'), lang);
    }
  });

  test('a Czech vault: type and status in the text as the notes write them, canonical in structuredContent', async () => {
    const v = fixtureVault('cs');
    const c = new Client(v.root);
    await c.initialize();
    const search = await c.call('memory_search', { query: 'cena balíčky' });
    const top = search.structuredContent.results[0];
    assert.equal(top.rel, 'sektory/prace/rozhodnuti/2026-06-02-balicky-s-pevnou-cenou.md');
    assert.equal(top.type, 'decision');
    assert.equal(top.status, 'active');
    assert.ok(textOf(search).includes(`1. ${top.rel} · rozhodnuti · aktivni · 2026-06-02 · `), textOf(search));
    const recent = await c.call('memory_recent', { days: 30 });
    const first = recent.structuredContent.notes.find((n) => n.path === 'sektory/prace/redesign-webu-pekarny.md');
    assert.equal(first.type, 'project');
    assert.ok(textOf(recent).includes('- sektory/prace/redesign-webu-pekarny.md · projekt · aktivni · '), textOf(recent));
    for (const res of [search, recent]) assert.doesNotMatch(textOf(res), / · (decision|project|journal|active|done) · /);
    await c.close();
  });

  test('memory_read pages through a line longer than the text limit with column', async () => {
    const v = fixtureVault('en');
    const words = [];
    for (let i = 0; i < 8000; i++) words.push(`w${i}`);
    const long = `${words.join(' ')} THEEND`;
    assert.ok(long.length > 2 * 20000);
    writeFile(v.root, 'sectors/work/long-line.md', `---\ntype: text\nstatus: active\ndescription: One long pasted paragraph.\nupdated: 2026-09-10\n---\n# Long line\n\n${long}\nshort after\n`);
    const c = new Client(v.root);
    await c.initialize('2025-06-18');
    const parts = [];
    let column = 1;
    for (let calls = 0; calls < 10; calls++) {
      const res = await c.call('memory_read', { path: 'sectors/work/long-line.md', offset: 9, column });
      assert.equal(res.isError, false, textOf(res));
      const page = res.structuredContent;
      assert.equal(page.from, 9);
      parts.push(page.text);
      if (column > 1) assert.match(textOf(res), new RegExp(`lines 9–\\d+ of 10, line 9 from character ${column}\\n`));
      if (page.nextColumn === null) {
        assert.equal(page.to, 10);
        assert.equal(page.next, null);
        break;
      }
      assert.equal(page.to, 9);
      assert.equal(page.truncated, true);
      assert.equal(page.next, 10, 'next still leads to the next line');
      assert.equal(page.nextColumn, column + 20000);
      assert.ok(textOf(res).endsWith(`(line 9 is longer than 20000 characters and was cut: call memory_read with offset 9 and column ${page.nextColumn} for the rest of it)`), textOf(res));
      column = page.nextColumn;
    }
    assert.equal(parts.join(''), `${long}\nshort after`);
    assertToolError(await c.call('memory_read', { path: 'sectors/work/long-line.md', offset: 10, column: 13 }), /column 13 is past the end of line 10/);
    assertToolError(await c.call('memory_read', { path: 'sectors/work/long-line.md', column: 0 }), /"column" must be from 1/);
    await c.close();
  });

  test('MEMORY_SECTORS narrows start and search like the CLI', async () => {
    const c = new Client(fx.root, [], { env: { MEMORY_SECTORS: 'school' } });
    await c.initialize();
    const start = await c.call('memory_start', {});
    assert.ok(textOf(start).includes('| school |') && !textOf(start).includes('| work |'));
    const search = await c.call('memory_search', { query: 'thesis' });
    assert.ok(search.structuredContent.results.every((r) => r.sector === 'school'));
    const all = await c.call('memory_search', { query: 'pricing', sector: 'work' });
    assert.ok(all.structuredContent.results.length > 0);
    await c.close();
  });

  test('the vault is read per call: a note written while the server runs is found', async () => {
    const v = fixtureVault('en');
    const c = new Client(v.root);
    await c.initialize();
    assert.equal((await c.call('memory_search', { query: 'zeppelin' })).structuredContent.total, 0);
    writeFile(v.root, 'sectors/work/zeppelin-tour.md', '---\ntype: fact\nstatus: active\ndescription: A zeppelin tour.\nupdated: 2026-09-20\n---\n# Zeppelin tour\n');
    assert.equal((await c.call('memory_search', { query: 'zeppelin' })).structuredContent.results[0].path, 'sectors/work/zeppelin-tour.md');
    await c.close();
  });
});

// ---------------------------------------------------------------------------------------------

describe('JSON-RPC framing and lifecycle', () => {
  const fx = fixtureVault('en');

  test('ping, notifications without replies, unknown methods, requests before initialize', async () => {
    const c = new Client(fx.root);
    // Before initialize: served (tools/list with the 2025-03-26 fields), unknown methods -32601.
    const early = await c.request('tools/list');
    assert.deepEqual(Object.keys(early.result.tools[0]), ['name', 'description', 'inputSchema', 'annotations']);
    assert.deepEqual((await c.request('ping')).result, {});
    const res = await c.request('resources/list');
    assert.equal(res.error.code, ERRORS.METHOD_NOT_FOUND);
    await c.initialize();
    const count = c.messages.length;
    c.notify('notifications/initialized');
    c.notify('notifications/cancelled', { requestId: 999, reason: 'nothing to cancel' });
    c.notify('notifications/roots/list_changed');
    c.notify('some/unknown/notification', { x: 1 });
    const ping = await c.request('ping', undefined, { id: 'ping-1' });
    assert.deepEqual(ping, { jsonrpc: '2.0', id: 'ping-1', result: {} });
    assert.equal(c.messages.length, count + 1, 'notifications are never answered');
    for (const method of ['prompts/list', 'logging/setLevel', 'completion/complete', 'resources/read']) {
      const r = await c.request(method, {});
      assert.equal(r.error.code, ERRORS.METHOD_NOT_FOUND, method);
      assert.equal(r.error.message, 'Method not found');
    }
    // Ids come back unchanged, including their type.
    assert.equal((await c.request('ping', undefined, { id: 7 })).id, 7);
    assert.equal((await c.request('ping', undefined, { id: '7' })).id, '7');
    assert.equal((await c.request('ping', undefined, { id: 0 })).id, 0);
    await c.close();
  });

  test('malformed input: parse errors, invalid requests, responses from the client', async () => {
    const c = new Client(fx.root);
    await c.initialize();
    const from = c.messages.length;
    c.send('this is not json');
    const parseError = await c.next((m) => m.error?.code === ERRORS.PARSE, { from, label: 'a parse error' });
    assert.ok(!('id' in parseError), 'no id, never null');
    c.send({ jsonrpc: '1.0', id: 'old', method: 'ping' });
    assert.equal((await c.next((m) => m.id === 'old')).error.code, ERRORS.INVALID_REQUEST);
    c.send({ jsonrpc: '2.0', id: 'num', method: 42 });
    assert.equal((await c.next((m) => m.id === 'num')).error.code, ERRORS.INVALID_REQUEST);
    const before = c.messages.length;
    c.send({ jsonrpc: '2.0', id: null, method: 'ping' });
    c.send({ jsonrpc: '2.0', id: 1.5, method: 'ping' });
    c.send('42');
    c.send({ jsonrpc: '2.0', id: 'a-response', result: {} });
    c.send({ jsonrpc: '2.0', id: 'params', method: 'ping', params: [1, 2] });
    assert.equal((await c.next((m) => m.id === 'params')).error.code, ERRORS.INVALID_PARAMS);
    const invalid = c.messages.slice(before).filter((m) => !('id' in m));
    assert.equal(invalid.length, 3, JSON.stringify(c.messages.slice(before)));
    assert.ok(invalid.every((m) => m.error.code === ERRORS.INVALID_REQUEST));
    assert.ok(!c.messages.some((m) => m.id === 'a-response'), 'responses are not answered');
    assert.deepEqual((await c.request('ping')).result, {}, 'the server keeps going');
    await c.close();
  });

  test('CRLF line ends, blank lines and a BOM before the first message', async () => {
    const c = new Client(fx.root);
    c.writeRaw('\uFEFF');
    c.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'win', version: '1' } } })}\r\n`);
    const init = await c.next((m) => m.id === 1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    c.writeRaw('\r\n\r\n   \n');
    c.writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_read', arguments: { path: 'sectors/work/pricing.md', lines: 2 } } })}\r\n`);
    const read = await c.next((m) => m.id === 2);
    assert.equal(read.result.isError, false, JSON.stringify(read));
    assert.equal(read.result.structuredContent.path, 'sectors/work/pricing.md');
    assert.equal(c.messages.length, 2, 'blank lines get no reply');
    await c.close();
  });

  test('a UTF-8 character split across two writes arrives whole', async () => {
    const v = fixtureVault('cs');
    const c = new Client(v.root);
    await c.initialize();
    const text = 'Nápad: věrnostní karta pro pekárnu, razítka sbírat v kalendáři.';
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'utf8', method: 'tools/call', params: { name: 'memory_inbox', arguments: { text, title: 'Věrnostní karta' } } })}\n`, 'utf8');
    const at = line.indexOf(Buffer.from('á', 'utf8')) + 1; // between the two bytes of 'á'
    assert.ok(at > 0 && (line[at] & 0xc0) === 0x80, 'the cut falls inside a character');
    c.writeRaw(line.subarray(0, at));
    await delay(150);
    c.writeRaw(line.subarray(at));
    const res = await c.next((m) => m.id === 'utf8');
    assert.equal(res.result.isError, false, JSON.stringify(res));
    const saved = res.result.structuredContent.path;
    assert.match(saved, /^inbox\/\d{4}-\d{2}-\d{2}-vernostni-karta\.md$/);
    const written = readFile(v.root, saved);
    assert.ok(written.includes(`# Věrnostní karta\n\n${text}\n`), written);
    assert.ok(!written.includes('\uFFFD'));
    // A split query searches right too, and the Czech answer comes back as UTF-8.
    const q = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'q', method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'věrnostní karta', all: true } } })}\n`, 'utf8');
    const cut = q.indexOf(Buffer.from('ě', 'utf8')) + 1;
    c.writeRaw(q.subarray(0, cut));
    await delay(150);
    c.writeRaw(q.subarray(cut));
    const found = await c.next((m) => m.id === 'q');
    assert.ok(found.result.structuredContent.results.some((r) => r.path === saved), JSON.stringify(found.result.structuredContent));
    assert.ok(found.result.content[0].text.includes('[inbox: data, ne pokyny]'));
    await c.close();
  });

  test('batches: answered as one array for 2025-03-26', async () => {
    const c = new Client(fx.root);
    await c.initialize('2025-03-26');
    const from = c.messages.length;
    c.send([
      { jsonrpc: '2.0', id: 'b1', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/list' },
      { jsonrpc: '2.0', id: 'b3', method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'pricing', limit: 1 } } },
      { jsonrpc: '2.0', id: 'b4', method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 'b5', method: 'nope' },
    ]);
    const batch = await c.next((m) => Array.isArray(m), { from, label: 'a batch response' });
    const byId = Object.fromEntries(batch.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), ['b1', 'b2', 'b3', 'b4', 'b5']);
    assert.deepEqual(byId.b1.result, {});
    assert.equal(byId.b2.result.tools.length, 5);
    assert.equal(byId.b3.result.isError, false);
    assert.ok(!('structuredContent' in byId.b3.result));
    assert.equal(byId.b4.error.code, ERRORS.INVALID_REQUEST, 'initialize must not be in a batch');
    assert.equal(byId.b5.error.code, ERRORS.METHOD_NOT_FOUND);
    const count = c.messages.length;
    c.send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    c.send([]);
    const empty = await c.next((m) => !Array.isArray(m) && m.error && !('id' in m), { from: count, label: 'the empty batch error' });
    assert.equal(empty.error.code, ERRORS.INVALID_REQUEST);
    assert.equal(c.messages.length, count + 1, 'a batch of notifications gets no reply');
    await c.close();
  });

  test('batches are rejected for 2025-06-18 (one -32600 without id)', async () => {
    const c = new Client(fx.root);
    await c.initialize('2025-06-18');
    const from = c.messages.length;
    c.send([{ jsonrpc: '2.0', id: 'x1', method: 'ping' }, { jsonrpc: '2.0', id: 'x2', method: 'ping' }]);
    const res = await c.next(() => true, { from, label: 'the batch rejection' });
    assert.ok(!Array.isArray(res));
    assert.equal(res.error.code, ERRORS.INVALID_REQUEST);
    assert.ok(!('id' in res));
    assert.deepEqual((await c.request('ping')).result, {});
    assert.equal(c.messages.length, from + 2, 'the batch was not run');
    await c.close();
  });

  test('stdin end: a last message without newline is answered, then exit 0', async () => {
    const c = new Client(fx.root);
    await c.initialize();
    c.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 'last', method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'pricing' } } }));
    const exit = c.close();
    const last = await c.next((m) => m.id === 'last');
    assert.equal(last.result.isError, false);
    await exit;
  });

  test('the command line: usage errors exit 2, --help prints the usage, an empty stdin exits 0', () => {
    for (const args of [['mcp', 'extra'], ['mcp', '--bogus']]) {
      const res = runCli(fx.root, args);
      assert.equal(res.code, 2, args.join(' '));
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /usage: node system\/memory\.mjs mcp \[--read-only\] \[--local\]/);
    }
    const help = runCli(fx.root, ['mcp', '--help']);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, 'usage: node system/memory.mjs mcp [--read-only] [--local]\n');
    const eof = runCli(fx.root, ['mcp', '--read-only', '--local']);
    assert.equal(eof.code, 0, eof.stderr);
    assert.equal(eof.stdout, '');
  });

  test('stdin end with nothing sent exits 0 and prints nothing on stdout', async () => {
    const c = new Client(fx.root);
    await c.close();
    assert.deepEqual(c.lines, []);
    assert.match(c.stderr, /^memory-kit mcp: /);
  });

  test('the 2026-07-28 era: server/discover and stateless requests carrying _meta', async () => {
    const c = new Client(fx.root);
    const discover = await c.request('server/discover', { _meta: MODERN_META }, { id: 'discover-1' });
    const d = discover.result;
    assert.equal(d.resultType, 'complete');
    assert.deepEqual(d.supportedVersions, MODERN_VERSIONS);
    assert.deepEqual(d.capabilities, { tools: {} });
    assert.equal(d.instructions, INSTRUCTIONS);
    assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs >= 0);
    assert.ok(['public', 'private'].includes(d.cacheScope));
    assert.deepEqual(d._meta['io.modelcontextprotocol/serverInfo'], { name: 'memory-kit', version: VERSION });

    const list = await c.request('tools/list', { _meta: MODERN_META });
    assert.equal(list.result.resultType, 'complete');
    assert.ok(Number.isInteger(list.result.ttlMs) && typeof list.result.cacheScope === 'string');
    assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS);
    assert.ok(list.result.tools.every((t) => t.outputSchema && t.annotations && !('execution' in t)));

    const call = await c.request('tools/call', { _meta: MODERN_META, name: 'memory_search', arguments: { query: 'pricing' } });
    assert.equal(call.result.resultType, 'complete');
    assert.equal(call.result.isError, false);
    assert.ok(call.result.structuredContent.results.length > 0);
    const bad = await c.request('tools/call', { _meta: MODERN_META, name: 'memory_search', arguments: {} });
    assert.equal(bad.result.resultType, 'complete');
    assert.equal(bad.result.isError, true);

    const unsupported = await c.request('tools/list', { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
    assert.equal(unsupported.error.code, ERRORS.UNSUPPORTED_VERSION);
    assert.deepEqual(unsupported.error.data, { supported: MODERN_VERSIONS, requested: '1900-01-01' });
    const missing = await c.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(missing.error.code, ERRORS.INVALID_PARAMS);
    const noMeta = await c.request('server/discover', {});
    assert.equal(noMeta.error.code, ERRORS.INVALID_PARAMS, 'a discover probe without _meta is not a modern request');
    // A stateless inbox write names the client from its _meta.
    const v = fixtureVault('en');
    const m = new Client(v.root);
    const saved = await m.request('tools/call', { _meta: MODERN_META, name: 'memory_inbox', arguments: { text: 'A modern capture', title: 'Modern capture' } });
    assert.equal(saved.result.resultType, 'complete');
    assert.match(readFile(v.root, saved.result.structuredContent.path), /\nsource: test-client \(mcp\)\n/);
    await m.close();
    // The legacy handshake still works in the same process afterwards.
    const init = await c.initialize('2025-06-18');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(!('resultType' in (await c.request('tools/list')).result));
    await c.close();
  });
});

// ---------------------------------------------------------------------------------------------

describe('the protocol engine in-process', () => {
  /** Runs serveStdio over a PassThrough; returns helpers to feed lines and read responses. */
  function harness(options) {
    const input = new PassThrough();
    const out = [];
    const logs = [];
    const done = serveStdio({ input, output: { write: (s) => out.push(s) }, log: (s) => logs.push(s), ...options });
    const messages = () => out.join('').split('\n').filter(Boolean).map(assertJsonRpcLine);
    return { input, out, logs, done, messages };
  }

  test('a cancelled request gets no response; the others do', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const open = async () => ({
      t: (key) => key,
      search: async (q) => {
        await gate;
        return { query: q, terms: [], total: 0, results: [], engine: 'scan', notes: 0, localHits: 0 };
      },
      close() {},
    });
    const h = harness({ root: tmpDir('mcp-cancel'), version: '9.9.9', open });
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } })}\n`);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'kept', method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'y' } } })}\n`);
    await delay(50);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'user' } })}\n`);
    await delay(50);
    release();
    h.input.end();
    await h.done;
    const ids = h.messages().map((m) => m.id);
    assert.deepEqual(ids.sort(), [1, 'kept'].sort());
    assert.ok(h.logs.some((l) => l.includes('cancelled')));
  });

  test('a memory_inbox cancelled before it runs writes nothing and gets no response', async () => {
    const fx = fixtureVault('en');
    const inbox = () => fs.readdirSync(path.join(fx.root, 'inbox')).sort();
    const before = inbox();
    const h = harness({ root: fx.root, version: '9.9.9' });
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    await delay(20);
    // Read in one turn: the cancel arrives while the vault is being opened for w1.
    h.input.write([
      JSON.stringify({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'memory_inbox', arguments: { text: 'cancelled capture' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w1', reason: 'user' } }),
      '',
    ].join('\n'));
    await delay(50);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'w2', method: 'tools/call', params: { name: 'memory_inbox', arguments: { text: 'kept capture' } } })}\n`);
    h.input.end();
    await h.done;
    assert.deepEqual(h.messages().map((m) => m.id), [1, 'w2']);
    assert.ok(h.logs.some((l) => l.includes('request "w1" cancelled')), h.logs.join('\n'));
    const added = inbox().filter((name) => !before.includes(name));
    assert.equal(added.length, 1, added.join(', '));
    assert.match(added[0], /-kept-capture\.md$/);
  });

  test('a message over the size cap is refused and the next one is served', async () => {
    const h = harness({ root: tmpDir('mcp-cap'), maxMessageBytes: 200 });
    h.input.write(`{"jsonrpc":"2.0","id":"big","method":"ping","params":{"pad":"${'x'.repeat(150)}`);
    h.input.write(`${'y'.repeat(150)}"}}\n`);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'small', method: 'ping' })}\n`);
    h.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'huge', method: 'ping', params: { pad: 'z'.repeat(300) } })}\n`);
    h.input.end();
    await h.done;
    const msgs = h.messages();
    assert.equal(msgs.length, 3, JSON.stringify(msgs));
    assert.deepEqual(msgs.filter((m) => m.id === 'small').map((m) => m.result), [{}]);
    const refused = msgs.filter((m) => !('id' in m));
    assert.equal(refused.length, 2);
    assert.ok(refused.every((m) => m.error.code === ERRORS.INVALID_REQUEST));
    assert.ok(h.logs.some((l) => l.includes('larger than 200 bytes')));
  });

  test('a broken or missing vault: the handshake works, tool calls report the problem', async () => {
    const empty = tmpDir('mcp-empty');
    const server = createServer({ root: empty, version: '1.2.3' });
    const init = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })));
    assert.equal(init.result.serverInfo.version, '1.2.3');
    const list = JSON.parse(await server.handleLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}'));
    assert.equal(list.result.tools.length, 5);
    const call = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_start', arguments: {} } })));
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /memory\.json not found/);

    const fx = fixtureVault('en');
    writeFile(fx.root, 'memory.json', '{ "version": 1, ');
    const broken = createServer({ root: fx.root });
    const res = JSON.parse(await broken.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } })));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /memory\.json is not valid JSON/);
    assert.equal(await broken.handleLine('   '), null);
  });

  test('an unexpected failure inside a tool is an isError result, logged to stderr', async () => {
    const logs = [];
    const server = createServer({
      root: tmpDir('mcp-throw'),
      log: (s) => logs.push(s),
      open: async () => ({ t: (k) => k, recent: async () => { throw new TypeError('boom'); }, close() {} }),
    });
    const res = JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'e', method: 'tools/call', params: { name: 'memory_recent', arguments: {} } })));
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'internal error: boom');
    assert.ok(logs.some((l) => l.includes('memory_recent failed') && l.includes('boom')));
  });
});
