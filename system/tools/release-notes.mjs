#!/usr/bin/env node
// Release notes for maintainers (not needed in a vault): prints the CHANGELOG.md section of one
// version, that is the lines under its heading "## x.y.z" or "## x.y.z (…)" up to the next "## "
// heading. .github/workflows/release.yml uses it as the body of the GitHub Release.
//
//   node system/tools/release-notes.mjs <version> [--file <CHANGELOG.md>] [--repo <owner/name>]
//
// --file defaults to CHANGELOG.md of this checkout. --repo rewrites relative links to the files at
// tag v<version> on GitHub, because a release page would resolve them against its own address.
// "## " lines inside fenced code blocks are text, not headings. Exit codes: 0 ok, 1 the version
// has no section (or an empty one), 2 usage, 3 internal error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node system/tools/release-notes.mjs <version> [--file <CHANGELOG.md>] [--repo <owner/name>]';
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The section of `version` in a changelog text without its heading, blank lines at both ends
 * trimmed, LF line ends; null when there is no heading for it.
 */
export function extractSection(text, version) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^## v?${escapeRe(version)}(?:\\s|$)`);
  let start = -1;
  let end = lines.length;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null || !lines[i].startsWith('## ')) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (heading.test(lines[i])) start = i + 1;
  }
  if (start < 0) return null;
  const body = lines.slice(start, end);
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n');
}

/** Markdown links with a relative target point to the file at `tag` in the GitHub repository. */
export function absoluteLinks(markdown, repo, tag) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|#|\/)/.test(target)) return whole;
    return `](https://github.com/${repo}/blob/${tag}/${target.replace(/^(?:\.\/)+/, '')})`;
  });
}

/** Runs the tool; returns the exit code. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        repo: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    stderr.write(`release-notes: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const m = positionals.length === 1 ? VERSION_RE.exec(positionals[0]) : null;
  if (!m) {
    stderr.write(`release-notes: give one version x.y.z\n${USAGE}\n`);
    return 2;
  }
  if (values.repo !== undefined && !REPO_RE.test(values.repo)) {
    stderr.write(`release-notes: --repo must be owner/name, got "${values.repo}"\n`);
    return 2;
  }
  const version = m[1];
  const file = path.resolve(values.file ?? path.join(HERE, '..', '..', 'CHANGELOG.md'));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    stderr.write(`release-notes: cannot read ${file}: ${err.code ?? err.message}\n`);
    return 1;
  }
  const section = extractSection(text, version);
  if (section === null || section === '') {
    stderr.write(`release-notes: ${path.basename(file)} has ${section === null ? 'no' : 'an empty'} section "## ${version}"\n`);
    return 1;
  }
  stdout.write(`${values.repo ? absoluteLinks(section, values.repo, `v${version}`) : section}\n`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`release-notes: internal error: ${err?.stack ?? err}\n`);
    process.exitCode = 3;
  }
}
