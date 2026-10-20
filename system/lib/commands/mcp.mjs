// `mcp`: serves the memory to AI apps as an MCP server over stdio (lib/mcp.mjs) until stdin ends,
// then exits 0. stdout carries JSON-RPC lines only; anything else this process prints goes to
// stderr. --read-only drops memory_inbox; --local lets notes of local roots leave the server.
// memory.json is read per tool call, so the server starts (and reports problems) even when the
// vault changes or is broken while it runs. MEMORY_SECTORS narrows start and search like the CLI.
// Each successful tool call is a line of the activity log (lib/activity.mjs), unless memory.json
// feedback.log is false then. --http serves the same over HTTP instead (lib/mcphttp.mjs): a URL
// for the apps that connect to a memory by a link, behind a token, on 127.0.0.1 by default.

import fs from 'node:fs';
import { logActivity } from '../activity.mjs';
import { serveStdio } from '../mcp.mjs';
import { ensureWorkDirIgnored, parseCli, splitList, usageError } from '../util.mjs';

export const usage = 'mcp [--read-only] [--local] [--http [--port 8787] [--host 127.0.0.1] [--allow-origin <url>]]';

function kitVersion() {
  try {
    return fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function log(text) {
  process.stderr.write(`memory-kit mcp: ${text}\n`);
}

export async function run(argv, cfg, ctx) {
  const parsed = parseCli(argv, {
    'read-only': { type: 'boolean' },
    local: { type: 'boolean' },
    http: { type: 'boolean' },
    port: { type: 'string' },
    host: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
  }, usage);
  if (!parsed) return 2;
  if (parsed.positionals.length) {
    usageError(`unexpected argument "${parsed.positionals[0]}"`, usage);
    return 2;
  }
  const root = ctx?.root ?? cfg?.root;
  if (!root) {
    usageError('no vault: pass --root <path>', usage);
    return 2;
  }
  const readOnly = parsed.values['read-only'] === true;
  const local = parsed.values.local === true;
  const version = kitVersion();
  if (parsed.values.http) return serveHttp(root, { readOnly, local, version, values: parsed.values });
  if (['port', 'host', 'allow-origin'].some((k) => parsed.values[k] !== undefined)) {
    usageError('--port, --host and --allow-origin go with --http', usage);
    return 2;
  }

  // Only protocol lines may reach stdout: a stray print anywhere in this process goes to stderr.
  const out = process.stdout;
  const ownWrite = Object.hasOwn(out, 'write');
  const original = out.write;
  const protocolWrite = (line) => original.call(out, line);
  out.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  log(`${version} serving ${root} (${readOnly ? 'read-only' : 'inbox writes allowed'}, local notes ${local ? 'shown' : 'hidden'})`);
  try {
    await serveStdio({
      input: process.stdin,
      output: { write: protocolWrite },
      log,
      root,
      readOnly,
      local,
      sectors: splitList(process.env.MEMORY_SECTORS),
      version,
      onActivity: (entry) => logActivity(root, entry),
    });
  } finally {
    if (ownWrite) out.write = original;
    else delete out.write;
  }
  return 0;
}

/** mcp --http: serves until the process is stopped (Ctrl+C), then exits 0. */
async function serveHttp(root, { readOnly, local, version, values }) {
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    usageError(`--port must be a number from 0 (any free port) to 65535, got "${values.port}"`, usage);
    return 2;
  }
  const host = values.host ?? '127.0.0.1';
  const { createHttpServer, serverToken } = await import('../mcphttp.mjs');
  ensureWorkDirIgnored(root);
  const { token, source, file } = serverToken(root);
  const server = createHttpServer({
    token, allowOrigins: values['allow-origin'] ?? [], log, root, readOnly, local,
    sectors: splitList(process.env.MEMORY_SECTORS), version, onActivity: (entry) => logActivity(root, entry),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const shown = host.includes(':') ? `[${host}]` : host;
  const where = `http://${shown}:${server.address().port}/mcp`;
  process.stdout.write([
    `memory-kit ${version}: the memory over HTTP at ${where} (${readOnly ? 'read-only' : 'inbox writes allowed'}, local notes ${local ? 'shown' : 'hidden'})`,
    `token: ${source === 'env' ? 'MEMORY_KIT_MCP_TOKEN' : file}${source === 'new' ? ' (new)' : ''}; send it as "Authorization: Bearer <token>", or use the link ${where}/<token>`,
    host === '127.0.0.1' || host === 'localhost' || host === '::1'
      ? 'only this computer reaches it; to reach it from the phone or the web, put a tunnel in front (Tailscale Funnel, Cloudflare Tunnel) with HTTPS'
      : `listening on ${host}: anyone who reaches this address and has the token can use the memory; use HTTPS in front of it`,
    'stop it with Ctrl+C',
    '',
  ].join('\n'));
  await new Promise((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
