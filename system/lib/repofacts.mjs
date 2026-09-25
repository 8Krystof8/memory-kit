// Facts about a code repository for the overview and the runbook of its dev sector: name,
// description, stack, languages, main folders and the commands that build, test and run it, for
// Node, Python, Rust, Go, PHP, Ruby, Java/Kotlin, .NET, Dart/Flutter, Deno, Makefile, justfile,
// Taskfile and Docker Compose. Read-only and bounded: at most 256 KB of each file, line-based
// parsing of TOML and YAML, nothing is executed, and every string that leaves this module passed
// the secret scanner (a string with a secret in it is dropped).

import fs from 'node:fs';
import path from 'node:path';
import { scanText } from './secrets.mjs';
import { parseJsonc } from './jsonc.mjs';

const MAX_READ = 256 * 1024;
const MAX_COMMANDS = 24;
const MAX_TARGETS = 10;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'vendor', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache']);
const LANGS = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.swift': 'Swift', '.cs': 'C#',
  '.fs': 'F#', '.cpp': 'C++', '.c': 'C', '.rb': 'Ruby', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart',
  '.sql': 'SQL', '.sh': 'Shell', '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML',
};
const NODE_FRAMEWORKS = ['react', 'next', 'vue', 'nuxt', 'svelte', 'astro', 'express', 'fastify', 'nestjs', 'vite', 'typescript',
  'tailwindcss', 'prisma', 'drizzle-orm', 'jest', 'vitest', 'playwright', 'electron'];
// package.json scripts shown first; lifecycle hooks are never shown.
const SCRIPT_ORDER = ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'format', 'check', 'e2e', 'preview'];
const LIFECYCLE = /^(pre|post)|^(prepare|prepublishOnly|install|uninstall|version)$/;

/** A string without secrets, on one line and at most max characters; '' when it holds a secret. */
export function clean(s, max = 200) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!text || scanText(text).length) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first MAX_READ bytes of a regular file as LF text, or null. */
export function readBounded(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_READ);
    const n = fs.readSync(fd, buf, 0, MAX_READ, 0);
    return buf.subarray(0, n).toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function jsonOf(text) {
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** Minimal TOML reading: section → {key: string value}; enough for names, descriptions and tables. */
export function tomlSections(text) {
  const out = new Map([['', {}]]);
  let cur = '';
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (sec) {
      cur = sec[1].replace(/\s+/g, '');
      if (!out.has(cur)) out.set(cur, {});
      continue;
    }
    const kv = /^("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const str = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(kv[2]);
    out.get(cur)[kv[1].replace(/^"|"$/g, '')] = str ? (str[1] ?? str[2]) : kv[2].trim();
  }
  return out;
}

/** Top-level `key: value` of a YAML text (line-based, quotes removed). */
function yamlTop(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(String(text ?? ''));
  if (!m) return '';
  return m[1].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
}

/** The keys one level below a top-level YAML key (`tasks:`, `services:`), with an optional `desc:`. */
export function yamlChildren(text, parent) {
  const out = [];
  let inside = false;
  let indent = null;
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (new RegExp(`^${parent}:\\s*(#.*)?$`).test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break;
    const m = /^(\s+)(["']?)([A-Za-z0-9_][A-Za-z0-9_:.-]*)\2:(\s|$)/.exec(line);
    if (m && (indent === null || m[1].length === indent)) {
      indent = m[1].length;
      cur = { name: m[3], what: '' };
      out.push(cur);
      continue;
    }
    const d = /^\s+desc(?:ription)?:\s*(.+)$/.exec(line);
    if (d && cur && !cur.what) cur.what = d[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Targets of a Makefile: no .PHONY or other special targets, no pattern rules, no variables. */
export function makeTargets(text) {
  const out = [];
  let comment = '';
  let inDefine = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^define\b/.test(line)) inDefine = true;
    if (inDefine) {
      if (/^endef\b/.test(line)) inDefine = false;
      continue;
    }
    if (/^\s*#/.test(line)) {
      comment = line.replace(/^\s*#+\s?/, '').trim();
      continue;
    }
    const m = /^([A-Za-z0-9_][^\s:=#$%]*(?:[ \t]+[A-Za-z0-9_][^\s:=#$%]*)*)[ \t]*:(?![:=])[^=]*?(?:##\s*(.*))?$/.exec(line);
    if (m) {
      for (const name of m[1].split(/\s+/)) {
        if (!name.includes('/') && !out.some((t) => t.name === name)) out.push({ name, what: (m[2] ?? comment).trim() });
      }
    }
    comment = '';
  }
  return out;
}

/** Recipes of a justfile (private ones, starting with _, left out). */
export function justRecipes(text) {
  const out = [];
  let comment = '';
  let hidden = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^#/.test(line)) {
      comment = line.replace(/^#+\s?/, '').trim();
      continue;
    }
    if (/^\[/.test(line)) {
      // Attributes such as [private] or [group('x')] keep the comment above them.
      if (/\bprivate\b/.test(line)) hidden = true;
      continue;
    }
    const m = /^@?([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+(?![=:])[^:]*)?[ \t]*:(?!=)/.exec(line);
    if (m && !hidden && !/^(set|alias|export|import|mod)$/.test(m[1]) && !out.some((r) => r.name === m[1])) out.push({ name: m[1], what: comment });
    comment = '';
    hidden = false;
  }
  return out;
}

function exists(top, rel) {
  try {
    fs.statSync(path.join(top, rel));
    return true;
  } catch {
    return false;
  }
}

function topEntries(top) {
  try {
    return fs.readdirSync(top, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// One reader per ecosystem. Each gets (top, read, f) and adds to f: stack, commands, name, description.

function node(top, read, f) {
  const j = jsonOf(read('package.json'));
  if (!j) return;
  f.setName(j.name);
  f.setDescription(j.description);
  const lock = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']]
    .find(([file]) => exists(top, file));
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(String(j.packageManager ?? ''));
  const pm = declared?.[1] ?? lock?.[1] ?? 'npm';
  const source = 'package.json';
  f.stack.push(`Node.js (${pm})`);
  if (j.workspaces || exists(top, 'pnpm-workspace.yaml')) f.stack.push('workspaces');
  const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
  f.stack.push(...NODE_FRAMEWORKS.filter((d) => deps.includes(d) || deps.includes(`@${d}/core`)));
  f.add(`${pm} install`, '', source, 'install');
  const scripts = j.scripts && typeof j.scripts === 'object' ? Object.keys(j.scripts).filter((k) => !LIFECYCLE.test(k)) : [];
  const ordered = [...SCRIPT_ORDER.filter((k) => scripts.includes(k)), ...scripts.filter((k) => !SCRIPT_ORDER.includes(k)).sort()];
  for (const k of ordered.slice(0, MAX_TARGETS)) f.add(`${pm} run ${k}`, j.scripts[k], source);
}

function python(top, read, f) {
  const py = read('pyproject.toml');
  const toml = tomlSections(py);
  const reqs = read('requirements.txt');
  const hasManage = exists(top, 'manage.py');
  if (py === null && reqs === null && !exists(top, 'Pipfile') && !exists(top, 'setup.py') && !hasManage) return;
  const project = toml.get('project') ?? {};
  const poetry = toml.get('tool.poetry') ?? {};
  f.setName(project.name ?? poetry.name);
  f.setDescription(project.description ?? poetry.description);
  const [tool, run, install] = exists(top, 'uv.lock') ? ['uv', 'uv run ', 'uv sync']
    : exists(top, 'poetry.lock') || toml.has('tool.poetry') ? ['Poetry', 'poetry run ', 'poetry install']
      : exists(top, 'Pipfile') ? ['Pipenv', 'pipenv run ', 'pipenv install --dev']
        : ['pip', '', reqs !== null ? 'pip install -r requirements.txt' : 'pip install -e .'];
  const source = py !== null ? 'pyproject.toml' : reqs !== null ? 'requirements.txt' : exists(top, 'Pipfile') ? 'Pipfile' : 'setup.py';
  f.stack.push(`Python (${tool})`);
  f.add(install, '', source, 'install');
  const deps = `${py ?? ''}\n${reqs ?? ''}\n${read('Pipfile') ?? ''}\n${read('requirements-dev.txt') ?? ''}`;
  const has = (word) => new RegExp(`(^|[^A-Za-z0-9_-])${word}([^A-Za-z0-9_-]|$)`, 'im').test(deps);
  const pytest = toml.has('tool.pytest.ini_options') || exists(top, 'pytest.ini') || exists(top, 'conftest.py') || has('pytest');
  if (hasManage) {
    f.stack.push('Django');
    f.add(`${run}python manage.py runserver`, '', 'manage.py', 'dev');
    if (!pytest) f.add(`${run}python manage.py test`, '', 'manage.py', 'test');
  }
  if (pytest) {
    f.stack.push('pytest');
    f.add(run ? `${run}pytest` : 'python -m pytest', '', source, 'test');
  }
  if (toml.has('tool.ruff') || exists(top, 'ruff.toml') || exists(top, '.ruff.toml') || has('ruff')) f.add(`${run}ruff check .`, '', source, 'lint');
  if (toml.has('tool.mypy') || exists(top, 'mypy.ini') || has('mypy')) f.add(`${run}mypy .`, '', source, 'typecheck');
}

function rust(top, read, f) {
  const text = read('Cargo.toml');
  if (text === null) return;
  const toml = tomlSections(text);
  const pkg = toml.get('package') ?? {};
  f.setName(pkg.name);
  f.setDescription(pkg.description);
  f.stack.push(toml.has('workspace') ? 'Rust (workspace)' : 'Rust');
  f.add('cargo build', '', 'Cargo.toml', 'build');
  if (exists(top, 'src/main.rs')) f.add('cargo run', '', 'Cargo.toml', 'run');
  f.add('cargo test', '', 'Cargo.toml', 'test');
  f.add('cargo clippy', '', 'Cargo.toml', 'lint');
  f.add('cargo fmt', '', 'Cargo.toml', 'format');
}

function go(top, read, f) {
  const text = read('go.mod');
  if (text === null) return;
  const mod = /^module\s+(\S+)/m.exec(text)?.[1];
  if (mod) f.setName(mod.split('/').pop());
  f.stack.push('Go');
  f.add('go build ./...', '', 'go.mod', 'build');
  f.add('go test ./...', '', 'go.mod', 'test');
  f.add('go vet ./...', '', 'go.mod', 'lint');
  const lint = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'].find((file) => exists(top, file));
  if (lint) f.add('golangci-lint run', '', lint, 'lint');
}

function php(top, read, f) {
  const j = jsonOf(read('composer.json'));
  const laravel = exists(top, 'artisan');
  if (!j && !laravel) return;
  if (j) {
    f.setName(String(j.name ?? '').split('/').pop());
    f.setDescription(j.description);
    f.stack.push('PHP (Composer)');
    f.add('composer install', '', 'composer.json', 'install');
    const scripts = j.scripts && typeof j.scripts === 'object' ? Object.keys(j.scripts).filter((k) => !/^(pre|post)-/.test(k)) : [];
    for (const k of scripts.slice(0, MAX_TARGETS)) {
      const body = Array.isArray(j.scripts[k]) ? j.scripts[k].join('; ') : j.scripts[k];
      f.add(`composer run ${k}`, typeof body === 'string' ? body : '', 'composer.json');
    }
  }
  if (laravel) {
    f.stack.push('Laravel');
    f.add('php artisan serve', '', 'artisan', 'dev');
    f.add('php artisan test', '', 'artisan', 'test');
  } else {
    const unit = ['phpunit.xml', 'phpunit.xml.dist'].find((file) => exists(top, file));
    if (unit) f.add('vendor/bin/phpunit', '', unit, 'test');
  }
}

function ruby(top, read, f) {
  const gemfile = read('Gemfile');
  const rake = exists(top, 'Rakefile');
  if (gemfile === null && !rake) return;
  const exec = gemfile !== null ? 'bundle exec ' : '';
  if (gemfile !== null) {
    f.stack.push('Ruby (Bundler)');
    f.add('bundle install', '', 'Gemfile', 'install');
  } else {
    f.stack.push('Ruby');
  }
  const rspec = exists(top, '.rspec') || /\brspec\b/.test(gemfile ?? '');
  if (exists(top, 'bin/rails')) {
    f.stack.push('Rails');
    f.add('bin/rails server', '', 'bin/rails', 'dev');
    if (!rspec) f.add('bin/rails test', '', 'bin/rails', 'test');
  }
  if (rspec) f.add(`${exec}rspec`, '', exists(top, '.rspec') ? '.rspec' : 'Gemfile', 'test');
  if (rake) f.add(`${exec}rake`, '', 'Rakefile', 'task');
}

function jvm(top, read, f) {
  if (exists(top, 'pom.xml')) {
    const mvn = exists(top, 'mvnw') ? './mvnw' : 'mvn';
    f.stack.push('Java (Maven)');
    f.add(`${mvn} package`, '', 'pom.xml', 'build');
    f.add(`${mvn} test`, '', 'pom.xml', 'test');
  }
  const build = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].find((file) => exists(top, file));
  if (build || exists(top, 'gradlew')) {
    const gradle = exists(top, 'gradlew') ? './gradlew' : 'gradle';
    f.stack.push(build?.endsWith('.kts') ? 'Gradle (Kotlin DSL)' : 'Gradle');
    f.add(`${gradle} build`, '', build ?? 'gradlew', 'build');
    f.add(`${gradle} test`, '', build ?? 'gradlew', 'test');
  }
}

function dotnet(top, read, f, entries) {
  const rank = (name) => (/\.slnx?$/i.test(name) ? 0 : 1);
  const files = entries.filter((e) => e.isFile() && /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(e.name)).map((e) => e.name)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  if (!files.length) return;
  f.stack.push('.NET');
  f.add('dotnet build', '', files[0], 'build');
  f.add('dotnet test', '', files[0], 'test');
}

function dart(top, read, f) {
  const text = read('pubspec.yaml');
  if (text === null) return;
  f.setName(yamlTop(text, 'name'));
  f.setDescription(yamlTop(text, 'description'));
  const flutter = /^\s+sdk:\s*flutter\b/m.test(text) || /^flutter:\s*$/m.test(text);
  const tool = flutter ? 'flutter' : 'dart';
  f.stack.push(flutter ? 'Flutter' : 'Dart');
  f.add(`${tool} pub get`, '', 'pubspec.yaml', 'install');
  f.add(`${tool} run`, '', 'pubspec.yaml', 'run');
  f.add(`${tool} test`, '', 'pubspec.yaml', 'test');
  f.add(`${tool} analyze`, '', 'pubspec.yaml', 'lint');
}

function deno(top, read, f) {
  const file = ['deno.json', 'deno.jsonc'].find((name) => exists(top, name));
  if (!file) return;
  let j = null;
  try {
    j = parseJsonc(read(file) ?? '').value;
  } catch {
    j = null;
  }
  f.stack.push('Deno');
  if (!j || typeof j !== 'object') return;
  f.setName(j.name);
  const tasks = j.tasks && typeof j.tasks === 'object' ? Object.entries(j.tasks) : [];
  for (const [name, body] of tasks.slice(0, MAX_TARGETS)) {
    const what = typeof body === 'string' ? body : body?.description ?? body?.command ?? '';
    f.add(`deno task ${name}`, what, file);
  }
}

function taskRunners(top, read, f) {
  const make = ['Makefile', 'makefile', 'GNUmakefile'].find((file) => exists(top, file));
  if (make) {
    f.stack.push('Make');
    for (const t of makeTargets(read(make)).slice(0, MAX_TARGETS)) f.add(`make ${t.name}`, t.what, make);
  }
  const just = ['justfile', 'Justfile', '.justfile'].find((file) => exists(top, file));
  if (just) {
    f.stack.push('just');
    for (const r of justRecipes(read(just)).slice(0, MAX_TARGETS)) f.add(`just ${r.name}`, r.what, just);
  }
  const task = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'].find((file) => exists(top, file));
  if (task) {
    f.stack.push('Task');
    for (const t of yamlChildren(read(task), 'tasks').filter((x) => !x.name.startsWith('_')).slice(0, MAX_TARGETS)) f.add(`task ${t.name}`, t.what, task);
  }
  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((file) => exists(top, file));
  if (compose) {
    const services = yamlChildren(read(compose), 'services').map((s) => clean(s.name, 40)).filter(Boolean).slice(0, 5);
    f.stack.push(services.length ? `Docker Compose (${services.join(', ')})` : 'Docker Compose');
    f.add('docker compose up', '', compose, 'up');
  } else if (exists(top, 'Dockerfile')) {
    f.stack.push('Docker');
  }
}

const READERS = [node, python, rust, go, php, ruby, jvm, dotnet, dart, deno, taskRunners];

function languages(top) {
  const counts = new Map();
  let seen = 0;
  const walk = (dir, depth) => {
    if (seen > 5000 || depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen > 5000) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      seen++;
      const lang = LANGS[path.extname(e.name).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  };
  walk(top, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([l]) => l);
}

function readmeParagraph(read) {
  const text = read('README.md') ?? read('readme.md') ?? read('README') ?? read('README.rst') ?? '';
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|!\[|<|\[!\[|---|===|\.\.)/.test(p));
  return clean(para ?? '', 400);
}

/**
 * Facts read from the code repository at top: { name, description, readme, stack, languages,
 * topDirs, commands: [{cmd, what, source, kind?}] }. kind (install, dev, run, build, test, lint,
 * typecheck, format, up, task) names a well-known command; what is the script or comment text.
 */
export function repoFacts(top) {
  const read = (rel) => readBounded(path.join(top, ...rel.split('/')));
  const entries = topEntries(top);
  const f = {
    name: '', description: '', stack: [], commands: [],
    setName(v) {
      if (!this.name) this.name = clean(v, 80);
    },
    setDescription(v) {
      if (!this.description) this.description = clean(v, 300);
    },
    add(cmd, what, source, kind) {
      const c = clean(cmd, 120);
      if (!c || this.commands.length >= MAX_COMMANDS || this.commands.some((x) => x.cmd === c)) return;
      this.commands.push({ cmd: c, what: clean(what, 160), source: clean(source, 60), ...(kind ? { kind } : {}) });
    },
  };
  for (const reader of READERS) {
    try {
      reader(top, read, f, entries);
    } catch {
      /* one unreadable ecosystem never stops the others */
    }
  }
  return {
    name: f.name || clean(path.basename(top), 80) || 'app',
    description: f.description,
    readme: readmeParagraph(read),
    stack: [...new Set(f.stack.map((s) => clean(s, 80)).filter(Boolean))],
    languages: languages(top),
    topDirs: entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).map((e) => clean(e.name, 60)).filter(Boolean).sort().slice(0, 15),
    commands: f.commands,
  };
}
