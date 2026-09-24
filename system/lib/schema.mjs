// A JSON Schema validator for the kit's own schemas (system/schema/*.schema.json): a zero-dependency
// subset of draft 2020-12. Pure: nothing here writes, and only loadSchema reads a file.
//
// Assertions: type (a name or a list, 'integer' included), enum, const, required, properties,
// patternProperties, additionalProperties (boolean or schema), propertyNames, minProperties,
// maxProperties, items, prefixItems, minItems, maxItems, uniqueItems, minimum, maximum,
// exclusiveMinimum, exclusiveMaximum, minLength and maxLength (in code points), pattern
// (unanchored, Unicode), format 'date' (a real calendar day; other formats are annotations),
// anyOf, oneOf, allOf, not, if/then/else and $ref inside the root schema ('#', '#/$defs/x' or any
// JSON pointer, also prefixed with the root's $id). Annotations (title, description, default, …)
// change nothing. A property whose value is undefined counts as absent, as in JSON.stringify.
//
// Every error names the value by a path such as `roots[1].privacy` or
// `files["system/kit.json"].sha256`; '' is the validated value itself.

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_DIR = 'system/schema';
export const SCHEMA_BASE = 'https://github.com/8Krystof8/memory-kit/schema/';
export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
/** The schemas the kit ships, by name (system/schema/<name>.schema.json). */
export const SCHEMA_NAMES = Object.freeze(['memory', 'note', 'kit', 'search-result', 'check-result', 'doctor-result']);

/** A schema that cannot be used: unreadable, not JSON, or using what this validator lacks. */
export class SchemaError extends Error {
  code = 'SCHEMA';
}

// English defaults; packs may translate the same keys (docs/architecture.md, section 4.10).
const DEFAULTS = Object.freeze({
  'schema.type': 'must be of type {expected}',
  'schema.type_or_value': 'must be of type {expected} or one of: {values}',
  'schema.const': 'must be {value}',
  'schema.enum': 'must be one of: {values}',
  'schema.required': 'is required but missing',
  'schema.additional': 'is not allowed here (unknown key)',
  'schema.false': 'is not allowed here',
  'schema.empty': 'must not be empty',
  'schema.min_length': 'must be at least {n} characters long',
  'schema.max_length': 'must be at most {n} characters long',
  'schema.pattern': 'must match the pattern {pattern}',
  'schema.blank': 'must not be empty or only spaces',
  'schema.date': 'must be a real calendar date YYYY-MM-DD',
  'schema.minimum': 'must be {n} or more',
  'schema.maximum': 'must be {n} or less',
  'schema.exclusive_minimum': 'must be more than {n}',
  'schema.exclusive_maximum': 'must be less than {n}',
  'schema.min_items': 'must have at least {n} items',
  'schema.max_items': 'must have at most {n} items',
  'schema.unique_items': 'must not repeat items: [{i}] and [{j}] are equal',
  'schema.min_properties': 'must have at least {n} keys',
  'schema.max_properties': 'must have at most {n} keys',
  'schema.property_name': 'is a key name that is not allowed: {detail}',
  'schema.not_value': 'must not be {value}',
  'schema.not': 'must not match the excluded shape',
  'schema.one_of': 'matches {n} of the allowed shapes, but must match exactly one',
});

/** Keywords this validator asserts or applies. */
const APPLIED = new Set([
  '$ref', '$defs', 'type', 'enum', 'const', 'required', 'properties', 'patternProperties',
  'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'format', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
]);
/** Keywords that only annotate. */
const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', 'contentMediaType', 'contentEncoding',
]);

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => isObject(v),
};

// A $ref chain that never reaches a child value loops; real schemas need a handful of hops.
const MAX_REF_HOPS = 64;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const regexCache = new Map();

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Own keys whose value is not undefined (what JSON.stringify would write). */
function definedKeys(obj) {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

function has(obj, key) {
  return Object.hasOwn(obj, key) && obj[key] !== undefined;
}

/** Deep equality of JSON values. */
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = definedKeys(a);
  const kb = definedKeys(b);
  return ka.length === kb.length && ka.every((k) => has(b, k) && equal(a[k], b[k]));
}

/** The JSON type name of a value ('integer' for whole numbers). */
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'non-finite number';
  return typeof v;
}

function isRealDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function regex(source) {
  let re = regexCache.get(source);
  if (!re) {
    if (typeof source !== 'string') throw new SchemaError(`pattern must be a string, got ${jsonType(source)}`);
    try {
      re = new RegExp(source, 'u');
    } catch (err) {
      throw new SchemaError(`invalid pattern ${JSON.stringify(source)}: ${err.message}`);
    }
    regexCache.set(source, re);
  }
  return re;
}

// ---------------------------------------------------------------------------------------------
// Paths and messages

function keyPath(base, key) {
  if (IDENT_RE.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${JSON.stringify(key)}]`;
}

const indexPath = (base, i) => `${base}[${i}]`;

function show(v) {
  const text = JSON.stringify(v);
  return text === undefined ? String(v) : text;
}

function interpolate(template, vars) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (all, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : all));
}

function say(t, key, vars) {
  if (typeof t === 'function') {
    const text = t(key, vars);
    if (typeof text === 'string' && text !== '' && text !== key) return text;
  }
  return interpolate(DEFAULTS[key], vars);
}

/** An error as the walk collects it; the message is rendered at the end (translatable). */
function issue(at, keyword, msg, params = {}) {
  return { path: at, keyword, msg, params };
}

function render(e, t) {
  const p = e.params;
  const vars = {};
  if (p.expected) vars.expected = p.expected.join(' | ');
  if (p.values) vars.values = p.values.map(show).join(', ');
  if (Object.hasOwn(p, 'value')) vars.value = show(p.value);
  for (const k of ['n', 'pattern', 'i', 'j']) if (Object.hasOwn(p, k)) vars[k] = p[k];
  if (Object.hasOwn(p, 'name')) vars.name = show(p.name);
  if (p.inner) vars.detail = render(p.inner, t);
  return say(t, `schema.${e.msg}`, vars);
}

// ---------------------------------------------------------------------------------------------
// $ref

function decodePointerPart(part) {
  let text;
  try {
    text = decodeURIComponent(part);
  } catch {
    text = part;
  }
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(state, ref) {
  if (typeof ref !== 'string') throw new SchemaError(`$ref must be a string, got ${jsonType(ref)}`);
  const cached = state.refs.get(ref);
  if (cached !== undefined) return cached;
  let pointer = ref;
  const id = isObject(state.root) && typeof state.root.$id === 'string' ? state.root.$id : null;
  if (id && ref === id) pointer = '#';
  else if (id && ref.startsWith(`${id}#`)) pointer = ref.slice(id.length);
  if (!pointer.startsWith('#') || (pointer.length > 1 && pointer[1] !== '/')) {
    throw new SchemaError(`unsupported $ref ${JSON.stringify(ref)}: only JSON pointers inside the schema (#/…) are supported`);
  }
  let node = state.root;
  for (const part of pointer.length > 1 ? pointer.slice(2).split('/') : []) {
    const key = decodePointerPart(part);
    let next;
    if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(key)) next = node[Number(key)];
    else if (isObject(node) && Object.hasOwn(node, key)) next = node[key];
    if (next === undefined) throw new SchemaError(`$ref ${JSON.stringify(ref)} does not resolve`);
    node = next;
  }
  if (!isObject(node) && typeof node !== 'boolean') throw new SchemaError(`$ref ${JSON.stringify(ref)} does not point at a schema`);
  state.refs.set(ref, node);
  return node;
}

// ---------------------------------------------------------------------------------------------
// The walk. Each function returns or appends the errors of one value against one schema.

function walk(state, schema, value, at, hops) {
  if (schema === true) return [];
  if (schema === false) return [issue(at, 'false', 'false')];
  if (!isObject(schema)) throw new SchemaError(`a schema must be an object or a boolean, got ${jsonType(schema)}`);
  const out = [];
  if (schema.$ref !== undefined) {
    if (hops >= MAX_REF_HOPS) throw new SchemaError(`$ref ${JSON.stringify(schema.$ref)} loops without reaching a value`);
    out.push(...walk(state, resolveRef(state, schema.$ref), value, at, hops + 1));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const name of types) if (!Object.hasOwn(TYPES, name)) throw new SchemaError(`unknown type ${show(name)}`);
    if (!types.some((name) => TYPES[name](value))) {
      out.push(issue(at, 'type', 'type', { expected: types }));
      return out; // the other keywords would only repeat that the type is wrong
    }
  }
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) {
    out.push(issue(at, 'const', 'const', { value: schema.const }));
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new SchemaError('enum must be an array');
    if (!schema.enum.some((v) => equal(v, value))) out.push(issue(at, 'enum', 'enum', { values: schema.enum }));
  }
  if (typeof value === 'string') strings(schema, value, at, out);
  else if (typeof value === 'number') numbers(schema, value, at, out);
  else if (Array.isArray(value)) arrays(state, schema, value, at, out);
  else if (isObject(value)) objects(state, schema, value, at, out);
  combinators(state, schema, value, at, hops, out);
  return out;
}

function limit(schema, key) {
  const n = schema[key];
  if (n === undefined) return undefined;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SchemaError(`${key} must be a number`);
  return n;
}

function strings(schema, value, at, out) {
  const min = limit(schema, 'minLength');
  const max = limit(schema, 'maxLength');
  if (min !== undefined || max !== undefined) {
    const len = [...value].length;
    if (min !== undefined && len < min) out.push(issue(at, 'minLength', min === 1 ? 'empty' : 'min_length', { n: min }));
    if (max !== undefined && len > max) out.push(issue(at, 'maxLength', 'max_length', { n: max }));
  }
  let patternFailed = false;
  if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) {
    patternFailed = true;
    // '\S' is how the schemas say "not blank"; the pattern itself would tell a reader little.
    out.push(issue(at, 'pattern', schema.pattern === '\\S' ? 'blank' : 'pattern', { pattern: schema.pattern }));
  }
  // Only what the pattern cannot tell: a well-formed but impossible day such as 2026-02-30.
  if (schema.format === 'date' && !patternFailed && !isRealDate(value)) out.push(issue(at, 'format', 'date'));
}

function numbers(schema, value, at, out) {
  const checks = [
    ['minimum', (n) => value < n, 'minimum'],
    ['maximum', (n) => value > n, 'maximum'],
    ['exclusiveMinimum', (n) => value <= n, 'exclusive_minimum'],
    ['exclusiveMaximum', (n) => value >= n, 'exclusive_maximum'],
  ];
  for (const [key, fails, msg] of checks) {
    const n = limit(schema, key);
    if (n !== undefined && fails(n)) out.push(issue(at, key, msg, { n }));
  }
}

function arrays(state, schema, value, at, out) {
  const min = limit(schema, 'minItems');
  const max = limit(schema, 'maxItems');
  if (min !== undefined && value.length < min) out.push(issue(at, 'minItems', min === 1 ? 'empty' : 'min_items', { n: min }));
  if (max !== undefined && value.length > max) out.push(issue(at, 'maxItems', 'max_items', { n: max }));
  if (schema.uniqueItems === true) {
    outer: for (let j = 1; j < value.length; j++) {
      for (let i = 0; i < j; i++) {
        if (equal(value[i], value[j])) {
          out.push(issue(at, 'uniqueItems', 'unique_items', { i, j }));
          break outer;
        }
      }
    }
  }
  let start = 0;
  if (schema.prefixItems !== undefined) {
    if (!Array.isArray(schema.prefixItems)) throw new SchemaError('prefixItems must be an array of schemas');
    start = schema.prefixItems.length;
    for (let i = 0; i < Math.min(start, value.length); i++) {
      out.push(...walk(state, schema.prefixItems[i], value[i], indexPath(at, i), 0));
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) throw new SchemaError('items must be a schema (tuples use prefixItems in draft 2020-12)');
    for (let i = start; i < value.length; i++) out.push(...walk(state, schema.items, value[i], indexPath(at, i), 0));
  }
}

function objects(state, schema, value, at, out) {
  const keys = definedKeys(value);
  const min = limit(schema, 'minProperties');
  const max = limit(schema, 'maxProperties');
  if (min !== undefined && keys.length < min) out.push(issue(at, 'minProperties', min === 1 ? 'empty' : 'min_properties', { n: min }));
  if (max !== undefined && keys.length > max) out.push(issue(at, 'maxProperties', 'max_properties', { n: max }));
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new SchemaError('required must be an array of names');
    for (const key of schema.required) if (!has(value, key)) out.push(issue(keyPath(at, key), 'required', 'required'));
  }
  const props = schema.properties ?? {};
  if (!isObject(props)) throw new SchemaError('properties must be an object');
  const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => [regex(p), s]);
  for (const key of keys) {
    const child = keyPath(at, key);
    let known = false;
    if (Object.hasOwn(props, key)) {
      known = true;
      out.push(...walk(state, props[key], value[key], child, 0));
    }
    for (const [re, sub] of patterns) {
      if (!re.test(key)) continue;
      known = true;
      out.push(...walk(state, sub, value[key], child, 0));
    }
    if (!known && schema.additionalProperties !== undefined) {
      if (schema.additionalProperties === false) out.push(issue(child, 'additionalProperties', 'additional'));
      else out.push(...walk(state, schema.additionalProperties, value[key], child, 0));
    }
    if (schema.propertyNames !== undefined) {
      const bad = walk(state, schema.propertyNames, key, child, 0);
      if (bad.length) out.push(issue(child, 'propertyNames', 'property_name', { name: key, inner: bad[0] }));
    }
  }
}

function combinators(state, schema, value, at, hops, out) {
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || schema[key].length === 0)) {
      throw new SchemaError(`${key} must be a non-empty array of schemas`);
    }
  }
  for (const sub of schema.allOf ?? []) out.push(...walk(state, sub, value, at, hops));
  if (schema.anyOf) {
    const results = schema.anyOf.map((sub) => walk(state, sub, value, at, hops));
    if (!results.some((errs) => errs.length === 0)) out.push(...closest(at, results, 'anyOf'));
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((sub) => walk(state, sub, value, at, hops));
    const passing = results.filter((errs) => errs.length === 0).length;
    if (passing === 0) out.push(...closest(at, results, 'oneOf'));
    else if (passing > 1) out.push(issue(at, 'oneOf', 'one_of', { n: passing }));
  }
  if (schema.not !== undefined && walk(state, schema.not, value, at, hops).length === 0) {
    const excluded = schema.not;
    out.push(isObject(excluded) && Object.hasOwn(excluded, 'const')
      ? issue(at, 'not', 'not_value', { value: excluded.const })
      : issue(at, 'not', 'not'));
  }
  if (schema.if !== undefined) {
    const branch = walk(state, schema.if, value, at, hops).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) out.push(...walk(state, branch, value, at, hops));
  }
}

/**
 * Why no alternative of anyOf/oneOf matched, told by the closest one: alternatives that fail on
 * the value's type or exact value are set aside, and of the rest the one with the fewest errors
 * speaks (the first on a tie). When every alternative fails on type or value, one error lists
 * what would have been accepted.
 */
function closest(at, results, keyword) {
  const shapeMiss = (e) => e.path === at && (e.keyword === 'type' || e.keyword === 'const' || e.keyword === 'enum');
  const relevant = results.filter((errs) => !errs.some(shapeMiss));
  if (relevant.length) return relevant.reduce((best, errs) => (errs.length < best.length ? errs : best));
  const types = [];
  const values = [];
  for (const e of results.flat().filter(shapeMiss)) {
    if (e.keyword === 'type') types.push(...e.params.expected);
    else if (e.keyword === 'const') values.push(e.params.value);
    else values.push(...e.params.values);
  }
  const uniqueTypes = [...new Set(types)];
  const covered = (v) => uniqueTypes.includes(jsonType(v)) || (jsonType(v) === 'integer' && uniqueTypes.includes('number'));
  const uniqueValues = values.filter((v, i) => !covered(v) && values.findIndex((w) => equal(v, w)) === i);
  if (!uniqueValues.length) return [issue(at, keyword, 'type', { expected: uniqueTypes })];
  if (!uniqueTypes.length) return [issue(at, keyword, 'enum', { values: uniqueValues })];
  return [issue(at, keyword, 'type_or_value', { expected: uniqueTypes, values: uniqueValues })];
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Validates a value against a schema. `root` is the schema that `$ref`s resolve in (pass the
 * whole schema file when `schema` is one of its $defs); `t` is an optional translator such as
 * cfg.t (key, vars) → text. Returns { ok, errors: [{ path, message, keyword }] }. Throws a
 * SchemaError when the schema itself cannot be used.
 */
export function validate(schema, value, { root = schema, t } = {}) {
  const state = { root, refs: new Map() };
  const errors = [];
  const seen = new Set();
  for (const e of walk(state, schema, value, '', 0)) {
    const message = render(e, t);
    // Two parts of a schema may say the same thing about one value (allOf branches); once is enough.
    const key = `${e.path}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ path: e.path, message, keyword: e.keyword });
  }
  return { ok: errors.length === 0, errors };
}

/** One line per error: `<label>: <path> <message>` (label and path only when present). */
export function formatErrors(errors, { label = '' } = {}) {
  return errors.map((e) => `${label ? `${label}: ` : ''}${e.path ? `${e.path} ` : ''}${e.message}`);
}

/** Reads and parses system/schema/<name>.schema.json of a kit. Throws a SchemaError. */
export function loadSchema(kitRoot, name) {
  if (!NAME_RE.test(String(name))) throw new SchemaError(`invalid schema name ${JSON.stringify(name)}`);
  const rel = `${SCHEMA_DIR}/${name}.schema.json`;
  let text;
  try {
    text = fs.readFileSync(path.join(kitRoot, ...rel.split('/')), 'utf8');
  } catch {
    throw new SchemaError(`schema not found: ${rel}`);
  }
  let schema;
  try {
    schema = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new SchemaError(`${rel} is not valid JSON: ${err.message}`);
  }
  if (!isObject(schema)) throw new SchemaError(`${rel} must hold a JSON object`);
  return schema;
}

/** loadSchema + validate in one call. */
export function validateAs(kitRoot, name, value, { t } = {}) {
  return validate(loadSchema(kitRoot, name), value, { t });
}

/**
 * What in a schema this validator would not enforce or cannot use: unknown keywords (typos
 * included), $refs that do not resolve, invalid patterns and unknown type names. Returns
 * ['<pointer>: <problem>'], empty for a usable schema.
 */
export function lintSchema(schema, { root = schema } = {}) {
  const problems = [];
  const state = { root, refs: new Map() };
  const visit = (node, at) => {
    if (typeof node === 'boolean') return;
    if (!isObject(node)) {
      problems.push(`${at}: a schema must be an object or a boolean`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!APPLIED.has(key) && !ANNOTATIONS.has(key)) problems.push(`${at}: unknown keyword ${JSON.stringify(key)}`);
    }
    const tryIt = (fn) => {
      try {
        fn();
      } catch (err) {
        problems.push(`${at}: ${err.message}`);
      }
    };
    if (node.$ref !== undefined) tryIt(() => resolveRef(state, node.$ref));
    if (node.pattern !== undefined) tryIt(() => regex(node.pattern));
    if (node.type !== undefined) {
      for (const name of [node.type].flat()) if (!Object.hasOwn(TYPES, name)) problems.push(`${at}: unknown type ${show(name)}`);
    }
    for (const key of ['properties', 'patternProperties', '$defs']) {
      if (node[key] === undefined) continue;
      if (!isObject(node[key])) {
        problems.push(`${at}/${key}: must be an object`);
        continue;
      }
      for (const [name, sub] of Object.entries(node[key])) {
        if (key === 'patternProperties') tryIt(() => regex(name));
        visit(sub, `${at}/${key}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      }
    }
    for (const key of ['additionalProperties', 'propertyNames', 'items', 'not', 'if', 'then', 'else']) {
      if (node[key] !== undefined) visit(node[key], `${at}/${key}`);
    }
    for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key])) problems.push(`${at}/${key}: must be an array`);
      else node[key].forEach((sub, i) => visit(sub, `${at}/${key}/${i}`));
    }
  };
  visit(schema, '#');
  return problems;
}
