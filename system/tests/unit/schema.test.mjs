// The JSON schemas of the kit (system/schema/) and their validator (system/lib/schema.mjs): the
// validator keyword by keyword, the schemas against real files and real CLI output in English and
// Czech, and the failure paths with the paths and messages a reader gets.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BUDGETS, loadConfig } from '../../lib/config.mjs';
import { parse } from '../../lib/frontmatter.mjs';
import {
  DRAFT_2020_12, SCHEMA_BASE, SCHEMA_DIR, SCHEMA_NAMES, SchemaError, formatErrors, lintSchema, loadSchema,
  validate, validateAs,
} from '../../lib/schema.mjs';
import { CANON_KEYS, CANON_STATUSES, CANON_TYPES } from '../../lib/util.mjs';
import { loadVault, parseNote } from '../../lib/vault.mjs';
import {
  KIT_ROOT, TODAY, bareRoot, copyKit, fixtureConfig, fixtureVault, removeTmpDirs, runCli, runInit, tmpDir,
  writeFile, writeJson,
} from '../helpers.mjs';

after(removeTmpDirs);

const schemas = Object.fromEntries(SCHEMA_NAMES.map((name) => [name, loadSchema(KIT_ROOT, name)]));
// Patterns as the messages quote them.
const DATE = schemas.note.$defs.date.pattern;
const REL_PATH = schemas.kit.$defs.relPath.pattern;
const VERSION = schemas.kit.$defs.version.pattern;
const AGENTS = schemas.memory.properties.agents.items.enum;

/** Asserts that value passes; the failure message lists every error. */
function assertValid(schema, value, what, { root } = {}) {
  const res = validate(schema, value, { root: root ?? schema });
  assert.ok(res.ok, `${what}:\n${formatErrors(res.errors).join('\n')}`);
}

/** The errors as '<path> <message>' lines. */
const lines = (res) => formatErrors(res.errors);
const pathsOf = (res) => res.errors.map((e) => e.path);

/** Parses the JSON a command printed; fails with its output when it is not JSON. */
function jsonOf(res, what) {
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    assert.fail(`${what} printed no JSON (exit ${res.code}): ${err.message}\n${res.stdout}\n${res.stderr}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The validator

describe('validate: types and values', () => {
  test('type names, lists of types, integer versus number', () => {
    assert.equal(validate({ type: 'integer' }, 3).ok, true);
    assert.equal(validate({ type: 'integer' }, 3.5).ok, false);
    assert.equal(validate({ type: 'number' }, 3.5).ok, true);
    assert.equal(validate({ type: 'number' }, 3).ok, true);
    assert.equal(validate({ type: 'number' }, Number.NaN).ok, false);
    assert.equal(validate({ type: 'object' }, []).ok, false);
    assert.equal(validate({ type: 'object' }, null).ok, false);
    assert.equal(validate({ type: 'array' }, {}).ok, false);
    assert.equal(validate({ type: 'boolean' }, 'true').ok, false);
    assert.equal(validate({ type: ['string', 'null'] }, null).ok, true);
    assert.deepEqual(validate({ type: ['string', 'null'] }, 5), {
      ok: false,
      errors: [{ path: '', message: 'must be of type string | null', keyword: 'type' }],
    });
  });

  test('a wrong type is reported once, not with every other keyword of the schema', () => {
    const res = validate({ type: 'string', enum: ['a'], minLength: 3, pattern: '^a' }, 5);
    assert.deepEqual(lines(res), ['must be of type string']);
  });

  test('const and enum compare JSON values deeply and show them as JSON', () => {
    assert.equal(validate({ const: { a: [1, { b: 2 }] } }, { a: [1, { b: 2 }] }).ok, true);
    assert.equal(validate({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }).ok, true);
    assert.deepEqual(lines(validate({ const: 'local' }, 'github')), ['must be "local"']);
    assert.deepEqual(lines(validate({ enum: ['on', 'off', null] }, 'sleep')), ['must be one of: "on", "off", null']);
    assert.equal(validate({ enum: [[1, 2]] }, [1, 2]).ok, true);
    assert.equal(validate({ enum: [1] }, 1.0).ok, true);
  });

  test('true accepts everything, false nothing', () => {
    assert.equal(validate(true, { any: 'thing' }).ok, true);
    assert.deepEqual(lines(validate(false, 1)), ['is not allowed here']);
    assert.deepEqual(lines(validate({ properties: { x: false } }, { x: 1, y: 2 })), ['x is not allowed here']);
  });
});

describe('validate: strings and numbers', () => {
  test('minLength and maxLength count code points; minLength 1 reads as "not empty"', () => {
    assert.equal(validate({ maxLength: 2 }, '👍👍').ok, true);
    assert.equal(validate({ minLength: 3 }, 'žlu').ok, true);
    assert.deepEqual(lines(validate({ minLength: 1 }, '')), ['must not be empty']);
    assert.deepEqual(lines(validate({ minLength: 3 }, 'ab')), ['must be at least 3 characters long']);
    assert.deepEqual(lines(validate({ maxLength: 2 }, '👍👍👍')), ['must be at most 2 characters long']);
  });

  test('pattern is unanchored and Unicode-aware; \\S reads as "not blank"', () => {
    assert.equal(validate({ pattern: 'b' }, 'abc').ok, true);
    assert.equal(validate({ pattern: '^\\p{L}+$' }, 'žluťoučký').ok, true);
    assert.deepEqual(lines(validate({ pattern: '^a' }, 'ba')), ['must match the pattern ^a']);
    assert.deepEqual(lines(validate({ pattern: '\\S' }, '  \t')), ['must not be empty or only spaces']);
    assert.equal(validate({ pattern: 'x' }, 5).ok, true, 'string keywords ignore other types');
  });

  test('format date asserts a real calendar day, beyond what the pattern can tell', () => {
    const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', format: 'date' };
    assert.equal(validate(date, '2024-02-29').ok, true);
    assert.deepEqual(lines(validate(date, '2026-02-30')), ['must be a real calendar date YYYY-MM-DD']);
    assert.deepEqual(lines(validate(date, '2026-2-3')), ['must match the pattern ^\\d{4}-\\d{2}-\\d{2}$'], 'one error, not two');
    assert.deepEqual(lines(validate({ format: 'date' }, 'soon')), ['must be a real calendar date YYYY-MM-DD']);
    assert.equal(validate({ format: 'email' }, 'not an address').ok, true, 'other formats only annotate');
  });

  test('minimum, maximum and the exclusive bounds', () => {
    const s = { minimum: 1, maximum: 20 };
    assert.equal(validate(s, 1).ok, true);
    assert.equal(validate(s, 20).ok, true);
    assert.deepEqual(lines(validate(s, 0)), ['must be 1 or more']);
    assert.deepEqual(lines(validate(s, 21)), ['must be 20 or less']);
    assert.deepEqual(lines(validate({ exclusiveMinimum: 0 }, 0)), ['must be more than 0']);
    assert.deepEqual(lines(validate({ exclusiveMaximum: 1 }, 1)), ['must be less than 1']);
  });
});

describe('validate: objects', () => {
  test('required names the missing key by its path', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { type: 'array', items: { required: ['c'] } } } } },
    };
    const res = validate(schema, { a: { b: [{ c: 1 }, {}] } });
    assert.deepEqual(res.errors, [{ path: 'a.b[1].c', message: 'is required but missing', keyword: 'required' }]);
  });

  test('keys that are not identifiers are written in brackets', () => {
    const schema = { additionalProperties: false, properties: { files: { additionalProperties: { type: 'string' } } } };
    const res = validate(schema, { files: { 'system/kit.json': 1, plain_key: 'x', 'two words': 2 }, '1st': true });
    assert.deepEqual(lines(res), [
      'files["system/kit.json"] must be of type string',
      'files["two words"] must be of type string',
      '["1st"] is not allowed here (unknown key)',
    ]);
  });

  test('a property whose value is undefined counts as absent', () => {
    const schema = { required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
    assert.deepEqual(lines(validate(schema, { a: undefined, b: undefined })), ['a is required but missing']);
    assert.equal(validate(schema, { a: 'x', b: undefined }).ok, true);
  });

  test('additionalProperties as a schema, patternProperties and propertyNames', () => {
    const schema = {
      properties: { name: { type: 'string' } },
      patternProperties: { '^x-': { type: 'number' } },
      additionalProperties: { type: 'boolean' },
      propertyNames: { pattern: '^[a-z-]+$' },
    };
    assert.equal(validate(schema, { name: 'n', 'x-size': 3, flag: true }).ok, true);
    assert.deepEqual(lines(validate(schema, { 'x-size': 'big', flag: 1, Bad: true })), [
      '["x-size"] must be of type number',
      'flag must be of type boolean',
      'Bad is a key name that is not allowed: must match the pattern ^[a-z-]+$',
    ]);
  });

  test('minProperties and maxProperties', () => {
    assert.deepEqual(lines(validate({ minProperties: 1 }, {})), ['must not be empty']);
    assert.deepEqual(lines(validate({ minProperties: 2 }, { a: 1 })), ['must have at least 2 keys']);
    assert.deepEqual(lines(validate({ maxProperties: 1 }, { a: 1, b: 2 })), ['must have at most 1 keys']);
  });
});

describe('validate: arrays', () => {
  test('items, prefixItems and the item paths', () => {
    const schema = { prefixItems: [{ const: 'main' }], items: { type: 'string' } };
    assert.equal(validate(schema, ['main', 'a', 'b']).ok, true);
    assert.equal(validate(schema, []).ok, true);
    assert.deepEqual(lines(validate(schema, ['other', 'a', 3])), ['[0] must be "main"', '[2] must be of type string']);
  });

  test('minItems, maxItems and uniqueItems', () => {
    assert.deepEqual(lines(validate({ minItems: 1 }, [])), ['must not be empty']);
    assert.deepEqual(lines(validate({ minItems: 2 }, [1])), ['must have at least 2 items']);
    assert.deepEqual(lines(validate({ maxItems: 2 }, [1, 2, 3])), ['must have at most 2 items']);
    assert.equal(validate({ uniqueItems: true }, [{ a: 1 }, { a: 2 }]).ok, true);
    assert.deepEqual(lines(validate({ uniqueItems: true }, [{ a: 1, b: 2 }, 5, { b: 2, a: 1 }])), [
      'must not repeat items: [0] and [2] are equal',
    ]);
  });
});

describe('validate: combinations', () => {
  const budget = { anyOf: [{ type: 'number', maximum: 7500 }, { type: 'array', prefixItems: [{ maximum: 7500 }, { maximum: 8500 }] }] };

  test('anyOf: the alternative of the right type tells what is wrong', () => {
    assert.equal(validate(budget, 7000).ok, true);
    assert.equal(validate(budget, [7000, 8000]).ok, true);
    assert.deepEqual(lines(validate(budget, 9000)), ['must be 7500 or less']);
    assert.deepEqual(lines(validate(budget, [7500, 9000])), ['[1] must be 8500 or less']);
  });

  test('anyOf: when no alternative has the right type, one error lists what would do', () => {
    const res = validate(budget, 'big');
    assert.deepEqual(res.errors, [{ path: '', message: 'must be of type number | array', keyword: 'anyOf' }]);
    const optionalDate = { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { const: '' }, { type: 'null' }] };
    assert.equal(validate(optionalDate, '').ok, true);
    assert.equal(validate(optionalDate, null).ok, true);
    assert.deepEqual(lines(validate(optionalDate, 5)), ['must be of type string | null'], 'the "" is a string, so not listed');
    assert.deepEqual(lines(validate(optionalDate, 'soon')), ['must match the pattern ^\\d{4}-\\d{2}-\\d{2}$']);
    assert.deepEqual(lines(validate({ anyOf: [{ const: 'a' }, { enum: ['b', 'c'] }] }, 'd')), ['must be one of: "a", "b", "c"']);
    assert.deepEqual(lines(validate({ anyOf: [{ type: 'boolean' }, { const: 'auto' }] }, 3)), [
      'must be of type boolean or one of: "auto"',
    ]);
  });

  test('oneOf: none or more than one alternative fails', () => {
    const schema = { oneOf: [{ type: 'integer' }, { type: 'number', minimum: 10 }] };
    assert.equal(validate(schema, 3).ok, true);
    assert.equal(validate(schema, 10.5).ok, true);
    assert.deepEqual(lines(validate(schema, 12)), ['matches 2 of the allowed shapes, but must match exactly one']);
    assert.deepEqual(lines(validate(schema, 'x')), ['must be of type integer | number']);
  });

  test('allOf adds up, not excludes', () => {
    assert.deepEqual(lines(validate({ allOf: [{ minimum: 2 }, { maximum: 1 }] }, 1.5)), ['must be 2 or more', 'must be 1 or less']);
    assert.deepEqual(lines(validate({ type: 'string', not: { const: 'main' } }, 'main')), ['must not be "main"']);
    assert.equal(validate({ not: { const: 'main' } }, 'mine').ok, true);
    assert.deepEqual(lines(validate({ not: { type: 'string' } }, 'x')), ['must not match the excluded shape']);
  });

  test('if/then/else applies the branch that the condition selects', () => {
    const schema = {
      if: { required: ['type'], properties: { type: { const: 'decision' } } },
      then: { required: ['created'] },
      else: { properties: { created: false } },
    };
    assert.equal(validate(schema, { type: 'decision', created: '2026-09-20' }).ok, true);
    assert.deepEqual(lines(validate(schema, { type: 'decision' })), ['created is required but missing']);
    assert.deepEqual(lines(validate(schema, { type: 'fact', created: '2026-09-20' })), ['created is not allowed here']);
    assert.equal(validate({ if: { const: 1 }, then: { const: 2 } }, 3).ok, true, 'no else: nothing to apply');
  });
});

describe('validate: $ref', () => {
  test('#/$defs/…, the root itself and JSON pointer escapes', () => {
    const tree = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { $ref: '#/$defs/a~1b' },
        kids: { type: 'array', items: { $ref: '#' } },
        tag: { $ref: '#/$defs/c~0d' },
        sp: { $ref: '#/$defs/with%20space' },
      },
      $defs: { 'a~b': { type: 'string' }, 'a/b': { type: 'string', minLength: 1 }, 'c~d': { const: 't' }, 'with space': { type: 'null' } },
    };
    assert.equal(validate(tree, { name: 'r', kids: [{ name: 'a', kids: [{ name: 'b' }] }], tag: 't', sp: null }).ok, true);
    assert.deepEqual(lines(validate(tree, { name: 'r', kids: [{ name: 'a', kids: [{ name: '' }, {}] }], tag: 'x', sp: 1 })), [
      'kids[0].kids[0].name must not be empty',
      'kids[0].kids[1].name is required but missing',
      'tag must be "t"',
      'sp must be of type null',
    ]);
  });

  test('a JSON pointer may lead into an array of schemas', () => {
    const schema = { type: 'array', prefixItems: [{ type: 'integer' }], items: { $ref: '#/prefixItems/0' } };
    assert.equal(validate(schema, [1, 2]).ok, true);
    assert.deepEqual(lines(validate(schema, [1, 'x'])), ['[1] must be of type integer']);
    assert.throws(() => validate({ items: { $ref: '#/prefixItems/1' }, prefixItems: [true] }, [1, 2]), /does not resolve/);
  });

  test('a $ref may carry the $id of the root; `root` lets a $defs entry be validated on its own', () => {
    const id = 'https://example.org/s.json';
    const schema = { $id: id, $defs: { n: { type: 'integer' }, pair: { prefixItems: [{ $ref: `${id}#/$defs/n` }] } } };
    assert.equal(validate(schema.$defs.pair, [1], { root: schema }).ok, true);
    assert.deepEqual(lines(validate(schema.$defs.pair, ['x'], { root: schema })), ['[0] must be of type integer']);
  });

  test('a schema the validator cannot use throws a SchemaError', () => {
    // Each keyword is checked when a value of its kind meets it; lintSchema checks a schema whole.
    const bad = [
      [{ $ref: '#/$defs/missing' }, 1, /does not resolve/],
      [{ $ref: 'https://example.org/other.json' }, 1, /only JSON pointers inside the schema/],
      [{ $ref: '#anchor' }, 1, /only JSON pointers inside the schema/],
      [{ $ref: '#' }, 1, /loops/],
      [{ allOf: [{ $ref: '#/$defs/a' }], $defs: { a: { $ref: '#' } } }, 1, /loops/],
      [{ type: 'text' }, 1, /unknown type "text"/],
      [{ items: [{ type: 'string' }] }, ['x'], /prefixItems/],
      [{ pattern: '(' }, 'x', /invalid pattern/],
      [{ anyOf: [] }, 1, /non-empty array/],
      [{ enum: 'a' }, 1, /enum must be an array/],
      [{ maxLength: '3' }, 'x', /maxLength must be a number/],
      [{ properties: { a: 5 } }, { a: 1 }, /must be an object or a boolean/],
    ];
    for (const [schema, value, message] of bad) {
      const expected = (err) => err instanceof SchemaError && err.code === 'SCHEMA' && message.test(err.message);
      assert.throws(() => validate(schema, value), expected, JSON.stringify(schema));
    }
  });

  test('the same error from two parts of a schema is reported once', () => {
    const res = validate({ allOf: [{ required: ['id'] }, { required: ['id'] }] }, {});
    assert.deepEqual(lines(res), ['id is required but missing']);
  });
});

describe('validate: messages', () => {
  test('a translator (cfg.t) replaces the English text; a missing translation falls back to it', () => {
    const cs = { 'schema.required': 'chybí (povinná položka)', 'schema.type': 'musí být typu {expected}' };
    const t = (key, vars) => (cs[key] ? cs[key].replace('{expected}', vars.expected) : key);
    const res = validate({ required: ['id'], properties: { n: { type: 'integer' }, s: { maxLength: 1 } } }, { n: 'x', s: 'ab' }, { t });
    assert.deepEqual(lines(res), ['id chybí (povinná položka)', 'n musí být typu integer', 's must be at most 1 characters long']);
  });

  test('the vault translator works as it is, before and after a pack translates the keys', () => {
    const cfg = loadConfig(bareRoot('cs'));
    const res = validate({ required: ['id'] }, {}, { t: cfg.t });
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].path, 'id');
    assert.ok(!res.errors[0].message.startsWith('schema.'), res.errors[0].message);
  });

  test('formatErrors puts an optional label first', () => {
    const errors = [{ path: 'roots[1].privacy', message: 'must be "local"' }, { path: '', message: 'must be of type object' }];
    assert.deepEqual(formatErrors(errors, { label: 'memory.json' }), [
      'memory.json: roots[1].privacy must be "local"',
      'memory.json: must be of type object',
    ]);
    assert.deepEqual(formatErrors(errors), ['roots[1].privacy must be "local"', 'must be of type object']);
  });
});

describe('lintSchema', () => {
  test('reports unknown keywords, dangling $refs, bad patterns and type names', () => {
    const problems = lintSchema({
      type: 'object',
      requried: ['a'],
      properties: { a: { type: 'strng' }, b: { $ref: '#/$defs/none' }, c: { pattern: '[' } },
      items: { maxlength: 3 },
    });
    assert.deepEqual(problems.map((p) => p.split(':')[0]), ['#', '#/properties/a', '#/properties/b', '#/properties/c', '#/items']);
    assert.match(problems[0], /unknown keyword "requried"/);
    assert.match(problems[4], /unknown keyword "maxlength"/);
  });

  test('accepts every keyword the validator applies', () => {
    assert.deepEqual(lintSchema({
      $schema: DRAFT_2020_12, $id: 'x', title: 't', description: 'd', $comment: 'c', default: 1, examples: [1],
      type: ['object', 'null'], required: [], properties: {}, patternProperties: { '^a': true }, additionalProperties: false,
      propertyNames: { pattern: '^[a-z]' }, minProperties: 0, maxProperties: 9, allOf: [true], anyOf: [true], oneOf: [true],
      not: false, if: true, then: true, else: true,
      $defs: { x: { items: true, prefixItems: [true], minItems: 0, maxItems: 1, uniqueItems: true } },
    }), []);
  });
});

// ---------------------------------------------------------------------------------------------
// The shipped schemas

describe('shipped schemas', () => {
  test('system/schema holds exactly the named schemas', () => {
    const files = fs.readdirSync(path.join(KIT_ROOT, ...SCHEMA_DIR.split('/'))).sort();
    assert.deepEqual(files, SCHEMA_NAMES.map((n) => `${n}.schema.json`).sort());
  });

  for (const name of SCHEMA_NAMES) {
    test(`${name}: draft 2020-12, its $id, a title and a description; every keyword is applied`, () => {
      const schema = schemas[name];
      assert.equal(schema.$schema, DRAFT_2020_12);
      assert.equal(schema.$id, `${SCHEMA_BASE}${name}.schema.json`);
      assert.ok(typeof schema.title === 'string' && schema.title.trim(), 'title');
      assert.ok(typeof schema.description === 'string' && schema.description.length > 40, 'description');
      assert.equal(schema.type, 'object');
      assert.deepEqual(lintSchema(schema), []);
      // A checkout may turn LF into CRLF; the kit hashes both alike (kit.mjs hashText).
      const text = fs.readFileSync(path.join(KIT_ROOT, ...SCHEMA_DIR.split('/'), `${name}.schema.json`), 'utf8').replace(/\r\n/g, '\n');
      assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n') && !text.startsWith('\uFEFF'), 'no BOM, one final newline');
    });
  }

  test('loadSchema refuses names outside system/schema and reports a missing or broken file', () => {
    for (const name of ['../memory', 'Memory', '', 'a/b', 'memory.schema']) {
      assert.throws(() => loadSchema(KIT_ROOT, name), (err) => err instanceof SchemaError && /invalid schema name/.test(err.message), name);
    }
    const root = tmpDir('schema-load');
    assert.throws(() => loadSchema(root, 'memory'), /schema not found: system\/schema\/memory\.schema\.json/);
    writeFile(root, 'system/schema/memory.schema.json', '{ "type": ');
    assert.throws(() => loadSchema(root, 'memory'), /memory\.schema\.json is not valid JSON/);
    writeFile(root, 'system/schema/memory.schema.json', '[]');
    assert.throws(() => loadSchema(root, 'memory'), /must hold a JSON object/);
    writeFile(root, 'system/schema/memory.schema.json', '\uFEFF{ "type": "integer" }\n');
    assert.deepEqual(loadSchema(root, 'memory'), { type: 'integer' });
    assert.equal(validateAs(root, 'memory', 3).ok, true);
    assert.deepEqual(lines(validateAs(root, 'memory', 'x')), ['must be of type integer']);
  });
});

// ---------------------------------------------------------------------------------------------
// memory.json

describe('memory.schema.json', () => {
  const schema = schemas.memory;
  const base = () => fixtureConfig('en');
  const withRoots = (...extra) => ({ ...base(), roots: [{ id: 'main', path: '.', privacy: 'github' }, ...extra] });

  test('the kit memory.json and the fixture configurations pass', () => {
    assertValid(schema, JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'memory.json'), 'utf8')), 'kit memory.json');
    assertValid(schema, fixtureConfig('en'), 'fixture en');
    assertValid(schema, fixtureConfig('cs'), 'fixture cs');
  });

  for (const lang of ['en', 'cs']) {
    test(`the memory.json init writes passes (${lang})`, () => {
      const root = copyKit(path.join(tmpDir(`schema-init-${lang}`), 'vault'));
      const res = runInit(root, [
        '--mode', 'combined', '--lang', lang, '--sectors', 'core,work,health:local',
        '--private-root', '../private', '--cleanup', 'none', '--today', TODAY, '--yes',
      ]);
      assert.equal(res.code, 0, `init: ${res.stderr}${res.stdout}`);
      const written = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'));
      assert.equal(written.roots.length, 2);
      assertValid(schema, written, `memory.json after init (${lang})`);
    });
  }

  // The schema mirrors loadConfig: what passes loads without an error or warning, what fails is
  // refused or warned about. (Only the disk can tell whether a pack exists or a root lies inside.)
  const VALID = {
    'every key left out': {},
    'only the version': { version: 1 },
    'the full fixture configuration': base(),
    'a local root': withRoots({ id: 'private', path: '../private', privacy: 'local' }),
    'main root written as ./': { ...base(), roots: [{ id: 'main', path: './', privacy: 'github' }] },
    'lowered budgets': { ...base(), budgets: { start_bytes: [7000, 8000], hook_bytes: 9000, sectors_on: 5, cold_days: 0 } },
    'budgets equal to the defaults': { ...base(), budgets: DEFAULT_BUDGETS },
    'search and eval at their limits': { ...base(), search: { log: true, n: 20 }, eval: { golden: 'tests/g.json', min: 0 } },
    'kit.source': { ...base(), kit: { source: 'https://example.org/memory-kit.git' } },
    'no profile': { ...base(), profile: null },
    'an unknown top-level key': { ...base(), custom: { kept: true } },
    'Czech': { ...fixtureConfig('cs'), roots: [{ id: 'main', path: '.', privacy: 'github' }] },
  };
  const INVALID = {
    'version 2': [{ ...base(), version: 2 }, 'version must be 1'],
    'version as text': [{ ...base(), version: '1' }, 'version must be of type integer'],
    'a language code with capitals': [{ ...base(), lang: 'EN' }, 'lang must match the pattern ^[a-z0-9][a-z0-9_-]*$'],
    'an unknown mode': [{ ...base(), mode: 'cloud' }, 'mode must be one of: "github", "local", "combined"'],
    'no roots': [{ ...base(), roots: [] }, 'roots must not be empty'],
    'a local root first': [
      { ...base(), roots: [{ id: 'private', path: '../private', privacy: 'local' }] },
      ['roots[0].id must be "main"', 'roots[0].path must be one of: ".", "./"', 'roots[0].privacy must be "github"'],
    ],
    'another id for the main root': [{ ...base(), roots: [{ id: 'repo', path: '.', privacy: 'github' }] }, 'roots[0].id must be "main"'],
    'the main root elsewhere': [
      { ...base(), roots: [{ id: 'main', path: 'sub', privacy: 'github' }] },
      'roots[0].path must be one of: ".", "./"',
    ],
    'a local root without id': [withRoots({ path: '../private', privacy: 'local' }), 'roots[1].id is required but missing'],
    'a second main root': [withRoots({ id: 'main', path: '../private', privacy: 'local' }), 'roots[1].id must not be "main"'],
    'a local root without path': [
      withRoots({ id: 'private', path: ' ', privacy: 'local' }),
      'roots[1].path must not be empty or only spaces',
    ],
    'a local root with privacy github': [
      withRoots({ id: 'private', path: '../private', privacy: 'github' }),
      'roots[1].privacy must be "local"',
    ],
    'a raised single budget': [{ ...base(), budgets: { hook_bytes: 10000 } }, 'budgets.hook_bytes must be 9500 or less'],
    'a raised warn level as one number': [{ ...base(), budgets: { start_bytes: 8000 } }, 'budgets.start_bytes must be 7500 or less'],
    'a raised hard level': [{ ...base(), budgets: { start_bytes: [7500, 9000] } }, 'budgets.start_bytes[1] must be 8500 or less'],
    'a negative budget': [{ ...base(), budgets: { cold_days: -1 } }, 'budgets.cold_days must be 0 or more'],
    'an empty budget pair': [{ ...base(), budgets: { start_bytes: [] } }, 'budgets.start_bytes must have at least 2 items'],
    'an unknown budget': [{ ...base(), budgets: { start_lines: 10 } }, 'budgets.start_lines is not allowed here (unknown key)'],
    'search.n 0': [{ ...base(), search: { n: 0 } }, 'search.n must be 1 or more'],
    'search.n 21': [{ ...base(), search: { n: 21 } }, 'search.n must be 20 or less'],
    'search.n 2.5': [{ ...base(), search: { n: 2.5 } }, 'search.n must be of type integer'],
    'eval.min above 1': [{ ...base(), eval: { min: 1.5 } }, 'eval.min must be 1 or less'],
    'a cleanup provider': [{ ...base(), cleanup: { provider: 'nightly' } }, 'cleanup.provider must be "none"'],
    'an unknown agent': [
      { ...base(), agents: ['claude-code', 'notepad'] },
      `agents[1] must be one of: ${AGENTS.map((a) => JSON.stringify(a)).join(', ')}`,
    ],
  };

  /** 'error' when loadConfig throws, 'warning' when it warns, 'clean' otherwise. */
  function configOutcome(root, value) {
    writeJson(root, 'memory.json', value);
    try {
      return loadConfig(root).warnings.length ? 'warning' : 'clean';
    } catch (err) {
      assert.equal(err.code, 'CONFIG', err.message);
      return 'error';
    }
  }

  test('what passes loads cleanly', () => {
    const root = bareRoot('en');
    for (const [what, value] of Object.entries(VALID)) {
      assertValid(schema, value, what);
      assert.equal(configOutcome(root, value), 'clean', what);
    }
  });

  test('what fails is refused or warned about by the kit, and the error says where', () => {
    const root = bareRoot('en');
    for (const [what, [value, expected]] of Object.entries(INVALID)) {
      const res = validate(schema, value);
      assert.deepEqual(lines(res), [expected].flat(), what);
      assert.notEqual(configOutcome(root, value), 'clean', what);
    }
  });

  test('the canonical form is asked for where the kit merely tolerates another', () => {
    const tolerated = {
      'initialized as text': [{ initialized: 'yes' }, 'initialized must be of type boolean'],
      'search.n as text': [{ search: { n: '5' } }, 'search.n must be of type integer'],
      'an empty profile': [{ profile: '' }, 'profile must not be empty'],
      'a budget pair of three': [{ budgets: { start_bytes: [1, 2, 3] } }, 'budgets.start_bytes must have at most 2 items'],
      'a non-object section': [{ search: 5 }, 'search must be of type object'],
      'an empty kit.source': [{ kit: { source: '' } }, 'kit.source must not be empty or only spaces'],
    };
    for (const [what, [value, line]] of Object.entries(tolerated)) assert.deepEqual(lines(validate(schema, value)), [line], what);
  });

  test('several problems at once, each with its own path', () => {
    const res = validate(schema, {
      version: 2,
      roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'main', path: '', privacy: 'lokal' }],
      budgets: { start_bytes: [9000, 9000], hook_bytes: 'x' },
      agents: 'claude-code',
    });
    assert.deepEqual(formatErrors(res.errors, { label: 'memory.json' }), [
      'memory.json: version must be 1',
      'memory.json: roots[1].id must not be "main"',
      'memory.json: roots[1].path must not be empty or only spaces',
      'memory.json: roots[1].privacy must be "local"',
      'memory.json: budgets.start_bytes[0] must be 7500 or less',
      'memory.json: budgets.start_bytes[1] must be 8500 or less',
      'memory.json: budgets.hook_bytes must be of type number',
      'memory.json: agents must be of type array',
    ]);
    assert.deepEqual(lines(validate(schema, [])), ['must be of type object']);
  });

  test('budgets mirror DEFAULT_BUDGETS: every key, each limit exactly', () => {
    const props = schema.$defs.budgets.properties;
    assert.deepEqual(Object.keys(props), Object.keys(DEFAULT_BUDGETS));
    for (const [key, def] of Object.entries(DEFAULT_BUDGETS)) {
      const at = (v) => validate(schema, { budgets: { [key]: v } });
      assert.deepEqual(props[key].default, def, key);
      assert.ok(at(def).ok, key);
      assert.ok(at(0).ok, key);
      assert.deepEqual(pathsOf(at(-1)), [`budgets.${key}`], key);
      if (Array.isArray(def)) {
        assert.ok(at(def[0]).ok, key);
        assert.ok(at([0, 0]).ok, key);
        assert.deepEqual(pathsOf(at(def[0] + 1)), [`budgets.${key}`], key);
        assert.deepEqual(pathsOf(at([def[0] + 1, def[1]])), [`budgets.${key}[0]`], key);
        assert.deepEqual(pathsOf(at([def[0], def[1] + 1])), [`budgets.${key}[1]`], key);
      } else {
        assert.deepEqual(pathsOf(at(def + 1)), [`budgets.${key}`], key);
        assert.equal(at([def, def]).ok, false, key);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Note frontmatter

describe('note.schema.json', () => {
  const schema = schemas.note;
  const good = {
    type: 'fact', status: 'active', description: 'Opening hours of the bakery.', updated: '2026-09-20', review_on: '2027-01-01',
  };

  test('knows exactly the canonical keys, types and statuses', () => {
    assert.deepEqual(Object.keys(schema.properties), CANON_KEYS);
    assert.deepEqual(schema.properties.type.enum, CANON_TYPES);
    assert.deepEqual(schema.properties.status.enum, CANON_STATUSES);
  });

  for (const lang of ['en', 'cs']) {
    test(`every fixture note outside the inbox passes as the kit reads it (${lang})`, () => {
      const { root } = fixtureVault(lang);
      const cfg = loadConfig(root);
      const vault = loadVault(cfg, { roots: 'all' });
      const notes = vault.notes.filter((n) => n.area !== 'inbox');
      assert.ok(notes.length >= 40, `${notes.length} notes`);
      assert.ok(notes.some((n) => n.local) && notes.some((n) => n.isManifest) && notes.some((n) => n.area === 'journal'));
      for (const n of notes) {
        assertValid(schema, n.data, `${n.root}:${n.rel}`);
        // An English note is canonical as written, too.
        if (lang === 'en') assertValid(schema, parse(n.text).data, `${n.rel} as written`);
      }
    });

    test(`every note template passes once filled in (${lang})`, () => {
      const cfg = loadConfig(bareRoot(lang));
      const dir = path.join(KIT_ROOT, ...cfg.dirs.templates.split('/'));
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      assert.ok(files.length >= 13);
      for (const file of files) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('{{date}}', TODAY).replaceAll('{{title}}', 'Title');
        const { data } = parseNote(cfg, { rel: `${cfg.dirs.sectors}/core/${file}`, text });
        const unfilled = lines(validate(schema, data));
        assert.deepEqual(unfilled, ['description must not be empty or only spaces'], `${file} before its description is filled in`);
        assertValid(schema, { ...data, description: 'What it holds and when to look.' }, file);
      }
    });
  }

  test('the starter notes of the kit pass as written', () => {
    for (const rel of ['sectors/core/_core.md', 'state.md', 'waiting.md']) {
      assertValid(schema, parse(fs.readFileSync(path.join(KIT_ROOT, ...rel.split('/')), 'utf8')).data, rel);
    }
  });

  test('unknown keys are kept; null means not set', () => {
    const extras = { tags: ['x'], cssclasses: 'wide' };
    const unset = { valid_until: null, created: '', pin: null, hot_max: null, aliases: null, replaced_by: null };
    assertValid(schema, { ...good, ...extras, ...unset }, 'extras');
  });

  const INVALID = {
    'nothing': [{}, ['type', 'status', 'description', 'updated'].map((key) => `${key} is required but missing`)],
    'an unknown type': [{ ...good, type: 'gadget' }, [`type must be one of: ${CANON_TYPES.map((v) => JSON.stringify(v)).join(', ')}`]],
    'a localized status': [{ ...good, status: 'aktivni' }, ['status must be one of: "active", "waiting", "done", "replaced", "rejected"']],
    'a blank description': [{ ...good, description: '  ' }, ['description must not be empty or only spaces']],
    'a description of 201 characters': [{ ...good, description: 'x'.repeat(201) }, ['description must be at most 200 characters long']],
    'an impossible date': [{ ...good, updated: '2026-02-30' }, ['updated must be a real calendar date YYYY-MM-DD']],
    'a date in another format': [{ ...good, valid_until: '31.12.2026' }, [`valid_until must match the pattern ${DATE}`]],
    'a decision without created': [{ ...good, type: 'decision' }, ['created is required but missing']],
    'a journal entry with an empty created': [
      { ...good, type: 'journal', status: 'done', created: null },
      ['created must be of type string'],
    ],
    'keywords as one word': [{ ...good, keywords: 'bakery' }, ['keywords must be of type array | null']],
    'a number among the aliases': [{ ...good, aliases: ['Bakery', 7] }, ['aliases[1] must be of type string']],
    'pin as text': [{ ...good, pin: 'yes' }, ['pin must be of type boolean | null']],
    'a key name with a space': [
      { ...good, 'my key': 1 },
      ['["my key"] is a key name that is not allowed: must match the pattern ^[A-Za-z_][A-Za-z0-9_-]*$'],
    ],
    'a manifest without its fields': [
      { ...good, type: 'sector', state: 'zapnuty', when_here: '' },
      [
        'state must be one of: "on", "sleep", "off", null',
        'privacy is required but missing',
        'not_here is required but missing',
        'when_here must not be empty or only spaces',
      ],
    ],
    'a manifest with its state or privacy left empty': [
      { ...good, type: 'sector', state: null, privacy: null, when_here: 'w', not_here: 'n' },
      ['state must be of type string', 'privacy must be of type string'],
    ],
    'a manifest with bad links and hot_max': [
      { ...good, type: 'sector', state: 'on', privacy: 'github', when_here: 'w', not_here: 'n', links: ['Work'], hot_max: 21, cleanup: 'x' },
      [
        'links[0] must match the pattern ^[a-z0-9]+(-[a-z0-9]+)*$',
        'hot_max must be 20 or less',
        'cleanup must be one of: "none", "", null',
      ],
    ],
  };

  for (const [what, [value, expected]] of Object.entries(INVALID)) {
    test(`fails with a path: ${what}`, () => {
      assert.deepEqual(lines(validate(schema, value)), expected);
    });
  }

  test('a manifest with every field passes', () => {
    assertValid(schema, {
      type: 'sector', status: 'active', description: 'Work: clients and projects.', updated: '2026-09-01',
      keywords: ['work', 'client', 'project', 'offer', 'invoice'], state: 'sleep', privacy: 'local',
      when_here: 'Clients.', not_here: 'School.', links: ['core', 'side-project'], hot_max: 0, cleanup: 'none',
    }, 'manifest');
  });
});

// ---------------------------------------------------------------------------------------------
// system/kit.json

describe('kit.schema.json', () => {
  const schema = schemas.kit;
  const sha = 'a'.repeat(64);
  const manifest = () => ({
    name: 'memory-kit', version: '0.1.1', data_version: 1, api_version: 1, node: '22.5.0', upgrade_from: '0.1.0',
    source: 'https://github.com/8Krystof8/memory-kit.git',
    files: { 'system/memory.mjs': { sha256: sha, group: 'code' }, '.githooks/pre-commit': { sha256: sha, group: 'config' } },
  });

  test('the kit.json and kit-history.json of this checkout pass, when present', (t) => {
    const kitFile = path.join(KIT_ROOT, 'system', 'kit.json');
    const historyFile = path.join(KIT_ROOT, 'system', 'kit-history.json');
    if (!fs.existsSync(kitFile)) return t.skip('system/kit.json is not in this checkout');
    const kit = JSON.parse(fs.readFileSync(kitFile, 'utf8'));
    assertValid(schema, kit, 'system/kit.json');
    assert.ok(Object.keys(kit.files).length > 50);
    if (fs.existsSync(historyFile)) {
      assertValid(schema.$defs.history, JSON.parse(fs.readFileSync(historyFile, 'utf8')), 'system/kit-history.json', { root: schema });
    }
  });

  test('a manifest built from this checkout passes', async (t) => {
    const kitModule = path.join(KIT_ROOT, 'system', 'lib', 'kit.mjs');
    if (!fs.existsSync(kitModule)) return t.skip('system/lib/kit.mjs is not in this checkout');
    const { buildManifest } = await import(pathToFileURL(kitModule).href);
    const built = buildManifest(KIT_ROOT);
    assertValid(schema, built, 'buildManifest(kit)');
    assert.ok(Object.keys(built.files).some((rel) => rel.startsWith('system/schema/')), 'the schemas are kit files');
  });

  test('a minimal manifest passes; the paths the kit ships are accepted', () => {
    assertValid(schema, manifest(), 'manifest');
    const files = {};
    const shipped = ['.github/workflows/ci.yml', '.agents/skills/memory/SKILL.md', 'GEMINI.md', 'docs/a..b/c.md', 'system/lang/cs/pack.json'];
    for (const rel of shipped) {
      files[rel] = { sha256: sha, group: 'docs' };
    }
    assertValid(schema, { ...manifest(), files }, 'paths');
    assertValid(schema, { ...manifest(), version: '1.0.0-rc.1' }, 'pre-release');
  });

  const entry = 'files["system/memory.mjs"]';
  const INVALID = {
    'an uppercase hash': [(m) => { m.files['system/memory.mjs'].sha256 = 'A'.repeat(64); }, [`${entry}.sha256 must match the pattern ^[0-9a-f]{64}$`]],
    'an unknown group': [(m) => { m.files['system/memory.mjs'].group = 'data'; }, [`${entry}.group must be one of: "code", "tests", "docs", "config"`]],
    'an entry without hash': [(m) => { delete m.files['system/memory.mjs'].sha256; }, [`${entry}.sha256 is required but missing`]],
    'an extra field in an entry': [(m) => { m.files['system/memory.mjs'].size = 1; }, [`${entry}.size is not allowed here (unknown key)`]],
    'a version with v': [(m) => { m.version = 'v0.1.1'; }, [`version must match the pattern ${VERSION}`]],
    'a two-part node version': [(m) => { m.node = '22.5'; }, [`node must match the pattern ${VERSION}`]],
    'data_version 0': [(m) => { m.data_version = 0; }, ['data_version must be 1 or more']],
    'no files': [(m) => { delete m.files; }, ['files is required but missing']],
    'an unknown field': [(m) => { m.channel = 'beta'; }, ['channel is not allowed here (unknown key)']],
  };
  for (const [what, [change, expected]] of Object.entries(INVALID)) {
    test(`fails with a path: ${what}`, () => {
      const m = manifest();
      change(m);
      assert.deepEqual(lines(validate(schema, m)), expected);
    });
  }

  test('file paths must be repository-relative POSIX paths', () => {
    const bad = ['sectors\\x.md', '../x.md', '/abs.md', 'a//b.md', './a.md', 'a/./b.md', 'a/../b.md', 'a/', 'C:\\kit\\x.md', '..', ''];
    for (const rel of bad) {
      const m = manifest();
      m.files[rel] = { sha256: sha, group: 'code' };
      const res = validate(schema, m);
      assert.equal(res.errors.length, 1, `${JSON.stringify(rel)}: ${lines(res).join('; ')}`);
      assert.equal(res.errors[0].keyword, 'propertyNames', rel);
      assert.match(res.errors[0].message, /is a key name that is not allowed: must match the pattern/);
    }
  });

  test('the history maps versions to paths to hashes', () => {
    const history = schema.$defs.history;
    assertValid(history, { '0.1.0': { 'system/memory.mjs': sha }, '0.1.1': {} }, 'history', { root: schema });
    assert.deepEqual(lines(validate(history, { latest: {}, '0.1.0': { 'system/memory.mjs': 'x', 'a\\b': sha } }, { root: schema })), [
      `latest is a key name that is not allowed: must match the pattern ${VERSION}`,
      '["0.1.0"]["system/memory.mjs"] must match the pattern ^[0-9a-f]{64}$',
      `["0.1.0"]["a\\\\b"] is a key name that is not allowed: must match the pattern ${REL_PATH}`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real output of search and check

const CASES = {
  en: { hit: 'calendar', local: 'dentist', inbox: 'loyalty card', archived: 'logo brief', dup: 'fixed price packages' },
  cs: { hit: 'kalendářem', local: 'zubař', inbox: 'věrnostní karta', archived: 'brief loga', dup: 'balíčky s pevnou cenou' },
};

for (const lang of ['en', 'cs']) {
  const c = CASES[lang];

  describe(`search --json against search-result.schema.json (${lang})`, () => {
    const schema = schemas['search-result'];
    let root;
    before(() => {
      ({ root } = fixtureVault(lang));
    });

    function search(args, what) {
      const res = runCli(root, ['search', ...args, '--json']);
      assert.equal(res.code, 0, `${what}: ${res.stderr}`);
      const json = jsonOf(res, what);
      assertValid(schema, json, what);
      return json;
    }

    test('with results', () => {
      const json = search([c.hit], c.hit);
      assert.ok(json.results.length > 0);
    });

    test('with no result', () => {
      const json = search(['zzqqxx'], 'no result');
      assert.deepEqual(json.results, []);
      assert.equal(json.total, 0);
    });

    test('with notes of a local sector (--local)', () => {
      const hidden = search([c.local], 'local hidden');
      assert.ok(hidden.localHits > 0 && hidden.results.every((r) => !r.local));
      const shown = search([c.local, '--local'], 'local shown');
      const local = shown.results.find((r) => r.local);
      assert.ok(local, 'a local result');
      assert.ok(local.path.startsWith('../') && local.root !== 'main', local.path);
    });

    test('with inbox and archived notes (--all), with --n and with the scan engine', () => {
      assert.ok(search([c.inbox, '--all'], 'inbox').results.some((r) => r.inbox));
      assert.ok(search([c.archived, '--all'], 'archive').results.some((r) => r.archived));
      assert.equal(search([c.hit, '--n', '1'], '--n 1').results.length, 1);
      assert.equal(search([c.hit, '--engine', 'scan'], 'scan').engine, 'scan');
    });

    test('--duplicates against #/$defs/duplicates', () => {
      for (const [title, verdict] of [[c.dup, 'duplicate'], ['zzqqxx wwvvyy', 'none']]) {
        const res = runCli(root, ['search', '--duplicates', title, '--json']);
        assert.equal(res.code, 0, res.stderr);
        const json = jsonOf(res, `--duplicates ${title}`);
        assertValid(schema.$defs.duplicates, json, `--duplicates ${title}`, { root: schema });
        assert.equal(json.verdict, verdict, title);
      }
    });
  });
}

describe('search-result.schema.json failure paths', () => {
  const schema = schemas['search-result'];
  const result = {
    rel: 'sectors/work/pricing.md', path: 'sectors/work/pricing.md', root: 'main', local: false, name: 'pricing',
    sector: 'work', type: 'fact', status: 'active', updated: '2026-09-15', description: 'Prices.', snippet: '', line: 0,
    score: 1.5, inbox: false, archived: false,
  };
  const out = () => ({ query: 'price', terms: ['price*'], total: 1, results: [{ ...result }], engine: 'fts5', notes: 3, localHits: 0 });

  test('each violation names its place', () => {
    const cases = [
      [(o) => { delete o.engine; }, 'engine is required but missing'],
      [(o) => { o.engine = 'bm25'; }, 'engine must be one of: "fts5", "scan"'],
      [(o) => { o.timing = 0.1; }, 'timing is not allowed here (unknown key)'],
      [(o) => { o.results[0].path = 'sectors\\work\\pricing.md'; }, 'results[0].path must match the pattern ^[^\\\\\\x00]+$'],
      [(o) => { o.results[0].rel = '/sectors/work/pricing.md'; }, `results[0].rel must match the pattern ${REL_PATH}`],
      [(o) => { o.results[0].line = -1; }, 'results[0].line must be 0 or more'],
      [(o) => { o.results[0].local = 'no'; }, 'results[0].local must be of type boolean'],
      [(o) => { delete o.results[0].snippet; }, 'results[0].snippet is required but missing'],
      [(o) => { o.localHits = 1.5; }, 'localHits must be of type integer'],
    ];
    assertValid(schema, out(), 'base');
    for (const [change, line] of cases) {
      const o = out();
      change(o);
      assert.deepEqual(lines(validate(schema, o)), [line], line);
    }
  });

  test('the duplicate verdict and best agree', () => {
    const dup = schema.$defs.duplicates;
    const candidate = { rel: 'sectors/work/pricing.md', name: 'pricing', type: 'fact', score: 9, shared: ['price', 'packag'] };
    assertValid(dup, { candidates: [candidate], verdict: 'duplicate', best: candidate.rel }, 'duplicate', { root: schema });
    assertValid(dup, { candidates: [], verdict: 'none', best: null }, 'none', { root: schema });
    const check = (value) => lines(validate(dup, value, { root: schema }));
    assert.deepEqual(check({ candidates: [candidate], verdict: 'duplicate', best: null }), ['best must be of type string']);
    assert.deepEqual(check({ candidates: [], verdict: 'none', best: 'x.md' }), ['best must be of type null']);
    assert.deepEqual(check({ candidates: [{ ...candidate, shared: 'price' }], verdict: 'maybe', best: null }), [
      'candidates[0].shared must be of type array',
      'verdict must be one of: "duplicate", "none"',
    ]);
  });

  test('the JS API search() returns the same shape, when the API is present', async (t) => {
    const apiFile = path.join(KIT_ROOT, 'system', 'api.mjs');
    if (!fs.existsSync(apiFile)) return t.skip('system/api.mjs is not in this checkout');
    const { openMemory } = await import(pathToFileURL(apiFile).href);
    if (typeof openMemory !== 'function') return t.skip('system/api.mjs has no openMemory yet');
    const { root } = fixtureVault('en');
    const memory = await openMemory(root);
    try {
      assertValid(schema, await memory.search('calendar'), 'api search');
      assertValid(schema, await memory.search('dentist', { local: true }), 'api search --local');
      assertValid(schema, await memory.search('zzqqxx'), 'api search without result');
    } finally {
      memory.close();
    }
  });
});

for (const lang of ['en', 'cs']) {
  describe(`check --json against check-result.schema.json (${lang})`, () => {
    const schema = schemas['check-result'];

    function check(root, args, what) {
      const res = runCli(root, ['check', ...args, '--json', '--today', TODAY]);
      assert.ok(res.code === 0 || res.code === 1, `${what}: exit ${res.code} ${res.stderr}`);
      const json = jsonOf(res, what);
      assertValid(schema, json, what);
      assert.equal(res.code, json.errors.length ? 1 : 0, `${what}: the exit code follows the errors`);
      return json;
    }

    test('before and after generating', () => {
      const { root } = fixtureVault(lang);
      const before = check(root, [], 'check');
      assert.ok(before.errors.some((f) => f.code === 'GEN_MISSING'));
      assert.equal(before.generated, undefined);
      const generated = check(root, ['--generate', '--lenient'], 'check --generate --lenient');
      assert.equal(generated.mode, 'lenient');
      assert.ok(generated.generated.written > 0);
      check(root, ['--strict'], 'check --strict after generating');
    });

    test('with findings in a local root, normalized notes and data errors', () => {
      const { root, priv, names } = fixtureVault(lang);
      const note = (...fm) => `---\n${fm.join('\n')}\n---\n# Title\n`;
      const work = `${names.sectors}/${names.work}`;
      const crlf = note('type: fact', 'status: active', 'description: CRLF line ends.', 'updated: 2026-09-01', 'review_on: 2026-12-01');
      writeFile(root, `${work}/crlf-note.md`, crlf.replace(/\n/g, '\r\n'));
      writeFile(priv, `${names.sectors}/${names.health}/broken-note.md`, note('type: fact', 'status: active', 'updated: 2026-09-01'));
      writeFile(root, `${work}/bad-type.md`, note('type: gadget', 'status: active', 'description: Unknown type.', 'updated: 2026-09-01'));
      const json = check(root, ['--generate'], 'check --generate with findings');
      assert.ok(json.normalized.length > 0, 'normalized');
      assert.ok([...json.errors, ...json.warnings].some((f) => f.root && f.root !== 'main'), 'a finding in a local root');
      assert.ok(json.errors.length > 0, 'errors');
      const lenient = check(root, ['--lenient'], 'check --lenient with findings');
      assert.ok(lenient.warnings.length > json.warnings.length, 'data errors become warnings');
    });

    test('when the generator fails', () => {
      const { root } = fixtureVault(lang);
      writeJson(root, 'memory.json', { ...fixtureConfig(lang), budgets: { start_bytes: [100, 200] } });
      const json = check(root, ['--generate'], 'check --generate over budget');
      assert.equal(typeof json.generated.error, 'string');
      assert.ok(json.errors.some((f) => f.code === 'GEN_BUDGET'));
    });
  });
}

describe('check-result.schema.json failure paths', () => {
  const schema = schemas['check-result'];
  const finding = { code: 'FM_REQUIRED', severity: 'error', rel: 'sectors/work/a.md', line: 1, msg: 'missing description' };
  const out = () => ({ mode: 'strict', errors: [{ ...finding }], warnings: [], notes: 3 });

  test('each violation names its place', () => {
    const cases = [
      [(o) => { o.errors[0].severity = 'warning'; }, ['errors[0].severity must be "error"']],
      [(o) => { o.warnings.push({ ...finding }); }, ['warnings[0].severity must be "warning"']],
      [(o) => { o.errors[0].root = 'main'; }, ['errors[0].root must not be "main"']],
      [(o) => { o.errors[0].code = 'fm_required'; }, ['errors[0].code must match the pattern ^[A-Z][A-Z0-9_]*$']],
      [(o) => { o.errors[0].line = 1.5; }, ['errors[0].line must be of type integer']],
      [(o) => { o.mode = 'loose'; }, ['mode must be one of: "strict", "lenient"']],
      [(o) => { delete o.notes; }, ['notes is required but missing']],
      [(o) => { o.generated = { written: 1 }; }, ['generated.removed is required but missing']],
      [(o) => { o.generated = { error: 5 }; }, ['generated.error must be of type string']],
      [(o) => { o.generated = 'yes'; }, ['generated must be of type object']],
      [(o) => { o.normalized = []; }, ['normalized must not be empty']],
      [(o) => { o.normalized = [{ rel: 'a.md' }]; }, ['normalized[0].root is required but missing']],
    ];
    assertValid(schema, out(), 'base');
    const full = { generated: { written: 0, removed: 1 }, normalized: [{ root: 'main', rel: 'a.md' }] };
    assertValid(schema, { ...out(), errors: [{ ...finding, root: 'private' }], ...full }, 'full');
    for (const [change, expected] of cases) {
      const o = out();
      change(o);
      assert.deepEqual(lines(validate(schema, o)), expected, expected[0]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// doctor --json

describe('doctor-result.schema.json', () => {
  const schema = schemas['doctor-result'];
  const IDS = ['node.version', 'node.fts5', 'config.memory_json', 'config.data_version', 'kit.version', 'kit.integrity',
    'kit.upgrade_lock', 'agents.block', 'adapters', 'git.repo', 'git.hooks_path', 'git.pre_commit', 'git.attributes', 'roots',
    'generated.fresh', 'platform', 'mcp.clients'];
  const report = () => ({
    kit: '0.1.1',
    root: '/home/owner/memory',
    checks: IDS.map((id, i) => ({
      id,
      status: ['ok', 'warn', 'fail'][i % 3],
      message: `${id} checked`,
      ...(i % 3 === 0 ? {} : { fix: i % 3 === 1 ? 'node system/memory.mjs check --generate' : null }),
    })),
    summary: { ok: 6, warn: 6, fail: 5 },
  });

  test('a report with every check the doctor runs passes', () => {
    assertValid(schema, report(), 'report');
    assertValid(schema, { ...report(), kit: null, checks: [] }, 'kit version unreadable');
  });

  test('each violation names its place', () => {
    const cases = [
      [(r) => { r.checks[0].status = 'error'; }, 'checks[0].status must be one of: "ok", "warn", "fail"'],
      [(r) => { r.checks[1].id = 'Node.Version'; }, 'checks[1].id must match the pattern ^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$'],
      [(r) => { r.checks[2].message = ' '; }, 'checks[2].message must not be empty or only spaces'],
      [(r) => { r.checks[3].details = []; }, 'checks[3].details is not allowed here (unknown key)'],
      [(r) => { r.checks[4].fix = 5; }, 'checks[4].fix must be of type string | null'],
      [(r) => { delete r.summary.fail; }, 'summary.fail is required but missing'],
      [(r) => { r.kit = 1; }, 'kit must be of type string | null'],
      [(r) => { r.root = ''; }, 'root must not be empty'],
    ];
    for (const [change, line] of cases) {
      const r = report();
      change(r);
      assert.deepEqual(lines(validate(schema, r)), [line], line);
    }
  });

  // The doctor command is built by its own module; this checks its real output once it exists.
  test('doctor --json prints a valid report, also for a broken memory.json', (t) => {
    const { root } = fixtureVault('en');
    const first = runCli(root, ['doctor', '--json']);
    if (first.code === 3 && !first.stdout.trim()) return t.skip('doctor is not built in this checkout');
    assert.ok(first.code === 0 || first.code === 1, `doctor: exit ${first.code} ${first.stderr}`);
    const json = jsonOf(first, 'doctor --json');
    assertValid(schema, json, 'doctor --json');
    assert.equal(json.checks.length, json.summary.ok + json.summary.warn + json.summary.fail);
    assert.equal(first.code, json.summary.fail ? 1 : 0);

    writeFile(root, 'memory.json', '{ "version": 1, ');
    const broken = runCli(root, ['doctor', '--json']);
    assert.ok(broken.code === 0 || broken.code === 1, `doctor with a broken memory.json: exit ${broken.code} ${broken.stderr}`);
    const report = jsonOf(broken, 'doctor --json with a broken memory.json');
    assertValid(schema, report, 'doctor --json with a broken memory.json');
    assert.ok(report.checks.some((ch) => ch.status === 'fail'), 'the broken file is a failure');
  });
});
