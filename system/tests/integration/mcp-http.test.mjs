// The MCP server over HTTP (lib/mcphttp.mjs, `mcp --http`): the token in the header or the path,
// browsers' origins refused, a session per client from initialize on, the tools as over stdio,
// notifications 202, GET 405; the command prints its URL and token file, on 127.0.0.1.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHttpServer, serverToken } from '../../lib/mcphttp.mjs';
import { fixtureVault, removeTmpDirs } from '../helpers.mjs';

after(removeTmpDirs);

const TOKEN = 't'.repeat(40);
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } };

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, body, { token = TOKEN, session, origin, url = '/mcp' } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['Mcp-Session-Id'] = session;
  if (origin) headers.Origin = origin;
  const res = await fetch(`${base}${url}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, session: res.headers.get('mcp-session-id'), json: text ? JSON.parse(text) : null };
}

describe('mcp over http', () => {
  const v = fixtureVault('en');
  const server = createHttpServer({ token: TOKEN, root: v.root, version: '9.9.9' });
  let base;
  after(() => server.close());

  test('the token: none or a wrong one is 401; a browser origin is 403', async () => {
    base = await listen(server);
    assert.equal((await post(base, INIT, { token: null })).status, 401);
    assert.equal((await post(base, INIT, { token: 'x'.repeat(40) })).status, 401);
    assert.equal((await post(base, INIT, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(base, INIT, { url: '/other' })).status, 404);
  });

  test('initialize gives a session; the tools work in it; a notification is 202; GET is 405', async () => {
    const init = await post(base, INIT);
    assert.equal(init.status, 200);
    assert.ok(init.session);
    assert.equal(init.json.result.serverInfo.version, '9.9.9');
    const session = init.session;
    assert.equal((await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session })).status, 202);
    const list = await post(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session });
    assert.ok(list.json.result.tools.some((t) => t.name === 'memory_search'));
    const found = await post(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'pricing' } } }, { session });
    assert.equal(found.json.result.isError ?? false, false, JSON.stringify(found.json));
    assert.equal((await post(base, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).status, 400, 'no session: initialize first');
    assert.equal((await post(base, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { session: 'nope' })).status, 404);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
  });

  test('the token as the last part of the path, for apps without headers', async () => {
    const init = await post(base, INIT, { token: null, url: `/mcp/${TOKEN}` });
    assert.equal(init.status, 200);
    assert.equal((await post(base, INIT, { token: null, url: '/mcp/wrong' })).status, 401);
    assert.equal((await post(base, INIT, { token: null, url: '/mcp/%E0' })).status, 401, 'a malformed escape is a 401, not a crash');
    assert.equal((await post(base, INIT)).status, 200, 'and the server still answers');
  });

  test('serverToken: the env first, else a file made once, owner only', () => {
    const long = 'k'.repeat(32);
    assert.deepEqual(serverToken(v.root, { env: { MEMORY_KIT_MCP_TOKEN: long } }), { token: long, source: 'env' });
    assert.throws(() => serverToken(v.root, { env: { MEMORY_KIT_MCP_TOKEN: 'abc' } }), /at least 32 characters/);
    const made = serverToken(v.root, { env: {} });
    assert.equal(made.source, 'new');
    assert.ok(made.token.length >= 40);
    assert.equal(serverToken(v.root, { env: {} }).token, made.token, 'the same token next time');
    if (process.platform !== 'win32') assert.equal(fs.statSync(made.file).mode & 0o777, 0o600);
  });

  test('mcp --http prints its URL on 127.0.0.1 and the token file', async () => {
    const child = spawn(process.execPath, [path.join(v.root, 'system', 'memory.mjs'), 'mcp', '--http', '--port', '0', '--root', v.root], { cwd: v.root });
    const banner = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        if (out.includes('Ctrl+C')) resolve(out);
      });
      child.on('exit', (code) => reject(new Error(`exited ${code}`)));
      setTimeout(() => reject(new Error(`no banner: ${out}`)), 15000);
    });
    child.kill('SIGTERM');
    assert.match(banner, /the memory over HTTP at http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(banner, /mcp-token/);
    assert.match(banner, /only this computer reaches it/);
  });
});
