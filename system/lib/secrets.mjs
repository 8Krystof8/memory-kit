// Secret scanning (docs/architecture.md, section 12). Every pattern is assembled from string
// pieces so this file never matches itself. Output never shows more than mask() of a value.

import fs from 'node:fs';
import path from 'node:path';
import { cmp, direntKind, git, isGitRepo, toPosix } from './util.mjs';

const ALLOW = 'memory-kit:' + 'allow-secret';
// Every file that is not binary is scanned, whatever its name (.env, .pem, .ini, no extension…).
// Binary = a NUL byte in the first 8 KB. Files above MAX_BYTES are reported, never skipped silently.
const SNIFF_BYTES = 8192;
const MAX_BYTES = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache']);
// Local state of upgrade and connect (backups may hold other apps' keys). Git never lists it (it is
// excluded), so only the walk of a vault without git skips it; a file forced into git is scanned.
const LOCAL_STATE_DIR = '.memory-kit';

// Boundaries that also work next to '-' and '_' (\b does not).
const B = (cls) => `(?<![${cls}])`;
const E = (cls) => `(?![${cls}])`;
const ALNUM = 'A-Za-z0-9';
const TOKEN = 'A-Za-z0-9_-';

function regexRule(id, source, flags = '') {
  const re = new RegExp(source, flags);
  return {
    id,
    test(line) {
      const m = re.exec(line);
      return m ? { col: m.index + 1, match: m[0] } : null;
    },
  };
}

const PASSWORD_KEYS = ['pass' + 'word', 'pass' + 'wd', 'pass', 'pwd', 'hes' + 'lo'];
const GENERIC_KEYS = ['sec' + 'ret', 'to' + 'ken', 'api[_-]?' + 'key', 'tajemstv' + '[ií]'];
const assignment = (keys, min) => new RegExp(
  `(?<![${ALNUM}])(?:[${ALNUM}]*[_-])?(?:${keys.join('|')})(?:[_-][${ALNUM}]*)?\\s*[:=]\\s*['"]?([^\\s'"]{${min},})`,
  'i',
);

// key = value with a letter and a digit in the value: 8+ chars for passwords, 16+ for the rest.
function genericRule(id, re) {
  return {
    id,
    test(line) {
      const m = re.exec(line);
      if (!m) return null;
      const value = m[1];
      if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return null;
      if (value.startsWith('${{') || value.startsWith('<') || value.startsWith('$') || value.startsWith('process.env')) return null;
      if (value.startsWith('[[') || /^(.)\1*$/.test(value)) return null;
      const col = m.index + m[0].length - value.length + 1;
      return { col, match: value };
    },
  };
}

export const SECRET_RULES = [
  regexRule('aws-access-key', `${B(ALNUM)}${'AK' + 'IA'}[0-9A-Z]{16}${E(ALNUM)}`),
  regexRule('github-token', `${B(ALNUM)}${'gh'}[pousr]${'_'}[A-Za-z0-9]{36,}${E(ALNUM)}`),
  regexRule('github-token', `${B(ALNUM)}${'github_' + 'pat_'}[A-Za-z0-9_]{22,}${E(ALNUM + '_')}`),
  regexRule('anthropic-key', `${B(TOKEN)}${'sk-' + 'ant-'}[${TOKEN}]{20,}${E(TOKEN)}`),
  regexRule('openai-key', `${B(TOKEN)}${'sk-'}(?!${'ant-'})(?:${'proj-'})?[${TOKEN}]{20,}${E(TOKEN)}`),
  regexRule('google-api-key', `${B(TOKEN)}${'AI' + 'za'}[0-9A-Za-z_-]{35}${E(TOKEN)}`),
  regexRule('slack-token', `${B(ALNUM)}${'xox'}[baprs]-[0-9A-Za-z-]{10,}${E(ALNUM + '-')}`),
  regexRule('stripe-live', `${B(ALNUM)}(?:sk|rk)_${'live_'}[0-9a-zA-Z]{16,}${E(ALNUM)}`),
  regexRule('private-key', `${'-----BEGIN '}(?:RSA |EC |OPENSSH |DSA |PGP )?${'PRIVATE KEY-----'}`),
  regexRule('jwt', `${B(TOKEN)}${'ey' + 'J'}[${TOKEN}]{10,}\\.${'ey' + 'J'}[${TOKEN}]{10,}\\.[${TOKEN}]{10,}${E(TOKEN)}`),
  regexRule('gitlab-token', `${B(TOKEN)}${'gl' + 'pat-'}[${TOKEN}]{20,}${E(TOKEN)}`),
  regexRule('npm-token', `${B(ALNUM)}${'np' + 'm_'}[A-Za-z0-9]{36,}${E(ALNUM)}`),
  regexRule('huggingface-token', `${B(ALNUM)}${'h' + 'f_'}[A-Za-z]{30,}${E(ALNUM)}`),
  regexRule('sendgrid-key', `${B(TOKEN)}${'S' + 'G.'}[${TOKEN}]{16,}\\.[${TOKEN}]{16,}${E(TOKEN)}`),
  regexRule('google-oauth-token', `${B(TOKEN)}${'ya' + '29.'}[${TOKEN}]{20,}${E(TOKEN)}`),
  genericRule('password-assignment', assignment(PASSWORD_KEYS, 8)),
  genericRule('generic-assignment', assignment(GENERIC_KEYS, 16)),
];

/** First 4 chars + '…' + '(length)'. */
export function mask(match) {
  const s = String(match);
  return `${[...s].slice(0, 4).join('')}…(${[...s].length})`;
}

/** Finds secrets in a text: one finding per rule and line. */
export function scanText(text, { rel } = {}) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW)) continue;
    const seen = new Set();
    for (const rule of SECRET_RULES) {
      if (seen.has(rule.id)) continue;
      const hit = rule.test(line);
      if (!hit) continue;
      seen.add(rule.id);
      out.push({ rule: rule.id, line: i + 1, col: hit.col, preview: mask(hit.match), ...(rel ? { rel } : {}) });
    }
  }
  return out;
}

function walkAll(root, relDir, out) {
  const dirAbs = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Real symlinks are skipped; other Windows reparse points are ordinary files and folders.
    const kind = direntKind(dirAbs, e);
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (kind === 'dir') {
      if (!SKIP_DIRS.has(e.name) && !(relDir === '' && e.name === LOCAL_STATE_DIR)) walkAll(root, rel, out);
    } else if (kind === 'file') {
      out.push(rel);
    }
  }
}

/** Files to scan (rel paths, sorted): git-tracked plus untracked-not-ignored, else a walk. */
export function listTextFiles(root) {
  let rels;
  if (isGitRepo(root)) {
    const res = git(root, ['ls-files', '-z', '-co', '--exclude-standard'], { allowFail: true });
    rels = res.ok ? res.stdout.split('\0').filter(Boolean).map(toPosix) : null;
  }
  if (!rels) {
    rels = [];
    walkAll(root, '', rels);
  }
  const out = [];
  for (const rel of new Set(rels)) {
    if (rel.split('/').some((p) => SKIP_DIRS.has(p))) continue;
    try {
      const st = fs.lstatSync(path.join(root, rel));
      if (!st.isFile()) continue;
    } catch {
      continue; // deleted in the work tree
    }
    out.push(rel);
  }
  return out.sort(cmp);
}

/** True when the first 8 KB of a file hold a NUL byte (images, PDFs, archives). */
function isBinary(abs, size) {
  const len = Math.min(size, SNIFF_BYTES);
  if (len === 0) return false;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(abs, 'r');
  try {
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.includes(0);
}

/** Scans files (default: listTextFiles). Returns [{rel, rule, line, col, preview}]. */
export function scanFiles(root, rels) {
  const list = rels ?? listTextFiles(root);
  const out = [];
  for (const rel of list) {
    const abs = path.join(root, rel);
    let text;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || isBinary(abs, st.size)) continue;
      if (st.size > MAX_BYTES) {
        out.push({ rel, rule: 'too-large-to-scan', line: 0, col: 0, preview: `${Math.round(st.size / 1048576)} MB` });
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const f of scanText(text)) out.push({ rel, ...f });
  }
  return out;
}
