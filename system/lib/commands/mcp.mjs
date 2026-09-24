// `mcp`: serves the memory to AI apps as an MCP server over stdio (lib/mcp.mjs) until stdin ends,
// then exits 0. stdout carries JSON-RPC lines only; anything else this process prints goes to
// stderr. --read-only drops memory_inbox; --local lets notes of local roots leave the server.
// memory.json is read per tool call, so the server starts (and reports problems) even when the
// vault changes or is broken while it runs. MEMORY_SECTORS narrows start and search like the CLI.

import fs from 'node:fs';
import { serveStdio } from '../mcp.mjs';
import { parseCli, splitList, usageError } from '../util.mjs';

export const usage = 'mcp [--read-only] [--local]';

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
  const parsed = parseCli(argv, { 'read-only': { type: 'boolean' }, local: { type: 'boolean' } }, usage);
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
    });
  } finally {
    if (ownWrite) out.write = original;
    else delete out.write;
  }
  return 0;
}
