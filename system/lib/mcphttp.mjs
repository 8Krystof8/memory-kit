// The MCP server over HTTP (`mcp --http`): the same tools as over stdio (lib/mcp.mjs), for the
// apps that reach a memory by a URL: Claude and ChatGPT on the web and the phone as a custom
// connector, other computers, a hosted gateway. The only module of the kit that listens on a port,
// and only when the owner starts it. Streamable HTTP, the plain part of it: one endpoint, a POST
// carries one JSON-RPC message and gets its answer as application/json (202 for a notification),
// a session per client (Mcp-Session-Id, given at initialize, forgotten after an idle hour), no
// server-sent events (GET answers 405).
//
// Every request needs the token: the header `Authorization: Bearer <token>`, or the token as the
// last part of the path (/mcp/<token>) for apps that cannot send a header. The token is
// MEMORY_KIT_MCP_TOKEN, else .memory-kit/mcp-token (made on the first start: 32 random bytes, owner
// only). A request that carries an Origin header (a web page in a browser) is refused unless that
// origin is allowed (--allow-origin), so no page can use the memory through the owner's browser.
// It binds 127.0.0.1 unless told otherwise: reaching it from the internet goes through a tunnel the
// owner sets up (Tailscale Funnel, Cloudflare Tunnel) or a hosted gateway in front of it.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MAX_MESSAGE_BYTES, createServer } from './mcp.mjs';
import { writeAtomic } from './fsafe.mjs';

export const TOKEN_REL = '.memory-kit/mcp-token';
const IDLE_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 64;

/** The token: MEMORY_KIT_MCP_TOKEN, else the token file (made now when there is none). */
export function serverToken(root, { env = process.env } = {}) {
  const given = String(env.MEMORY_KIT_MCP_TOKEN ?? '').trim();
  // A short token can be guessed: the same floor as the file's.
  if (given && given.length < 32) throw new Error('MEMORY_KIT_MCP_TOKEN must be at least 32 characters (try: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))")');
  if (given) return { token: given, source: 'env' };
  const file = path.join(root, ...TOKEN_REL.split('/'));
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (kept.length >= 32) return { token: kept, source: 'file', file };
  } catch {
    /* none yet */
  }
  const made = randomBytes(32).toString('base64url');
  writeAtomic(file, `${made}\n`, { mode: 0o600 });
  return { token: made, source: 'new', file };
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The token a request carries (the bearer header, or the last part of the path), or null. */
export function requestToken(req, base) {
  const auth = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m) return m[1];
  const url = String(req.url ?? '').split('?')[0];
  if (!url.startsWith(`${base}/`)) return null;
  try {
    return decodeURIComponent(url.slice(base.length + 1)) || null;
  } catch {
    return null; // a malformed escape is no token
  }
}

const send = (res, status, body, headers = {}) => {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(text);
};
const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

/**
 * An http.Server serving the memory at `base` (default /mcp). Options as createServer (root,
 * readOnly, local, sectors, version, log, onActivity) plus token, allowOrigins, now (tests).
 */
export function createHttpServer({ token, base = '/mcp', allowOrigins = [], log = () => {}, now = () => Date.now(), maxMessageBytes = MAX_MESSAGE_BYTES, ...options }) {
  if (!token) throw new Error('mcp --http needs a token');
  const sessions = new Map();
  const sweep = () => {
    for (const [id, s] of sessions) if (now() - s.seen > IDLE_MS) sessions.delete(id);
  };

  return http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      log(`internal error: ${err?.stack ?? err}`);
      if (!res.headersSent) send(res, 500, rpcError(-32603, 'Internal error'));
    }
  });

  function handle(req, res) {
    const url = String(req.url ?? '').split('?')[0];
    if (url !== base && !url.startsWith(`${base}/`)) return send(res, 404, rpcError(-32601, 'Not found'));
    const origin = req.headers.origin;
    if (origin && !allowOrigins.includes(origin)) return send(res, 403, rpcError(-32600, 'Forbidden origin'));
    const given = requestToken(req, base);
    if (!given || !same(given, token)) return send(res, 401, rpcError(-32600, 'Unauthorized'), { 'WWW-Authenticate': 'Bearer' });
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      if (sid) sessions.delete(String(sid));
      return send(res, 204);
    }
    if (req.method !== 'POST') return send(res, 405, rpcError(-32600, 'Method not allowed: POST only, no event stream'), { Allow: 'POST, DELETE' });
    const chunks = [];
    let size = 0;
    let dropped = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxMessageBytes) dropped = true;
      else chunks.push(c);
    });
    req.on('end', async () => {
      if (dropped) return send(res, 413, rpcError(-32600, `Invalid Request: message larger than ${maxMessageBytes} bytes`));
      const text = Buffer.concat(chunks).toString('utf8');
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        /* the server answers a parse error itself */
      }
      sweep();
      let session = sid ? sessions.get(String(sid)) : null;
      let id = sid ? String(sid) : null;
      if (!session) {
        if (msg?.method !== 'initialize') {
          return send(res, sid ? 404 : 400, rpcError(-32600, sid ? 'Unknown session: initialize again' : 'Missing Mcp-Session-Id: initialize first'));
        }
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = [...sessions].sort((a, b) => a[1].seen - b[1].seen)[0];
          sessions.delete(oldest[0]);
        }
        id = randomUUID();
        session = { server: createServer({ ...options, log }), seen: now() };
        sessions.set(id, session);
      }
      session.seen = now();
      try {
        const out = await session.server.handleLine(text);
        if (out === null) return send(res, 202, undefined, { 'Mcp-Session-Id': id });
        return send(res, 200, out, { 'Mcp-Session-Id': id });
      } catch (err) {
        log(`internal error: ${err?.stack ?? err}`);
        return send(res, 500, rpcError(-32603, 'Internal error'));
      }
    });
    req.on('error', () => {
      if (!res.headersSent) send(res, 400, rpcError(-32600, 'Bad request'));
    });
  }
}
