// Text normalization and language analysis for search, the catalog and duplicate detection.
// The order of normalization is law: NFC -> lowercase -> stem -> strip diacritics. Stripping
// diacritics first breaks the stemmer ("rozhodnutím" would stay "rozhodnutim").

import { fileURLToPath } from 'node:url';

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const MARKS = /\p{M}/gu;
const REGEX_META = /[\\^$.*+?()[\]{}|\/-]/g;
const LANG_CODE = /^[a-z0-9][a-z0-9_-]*$/;
const MIN_TERM_CHARS = 2;
const MIN_PREFIX_CHARS = 4; // a base found by the stemmer
const MIN_ASCII_CUT = 3; // a base left after cutting a pack ending (cenach → cen)

/** NFC-normalizes any value (null and undefined become ''). */
export function nfc(s) {
  return String(s ?? '').normalize('NFC');
}

/** NFC -> lowercase -> strip diacritics. The form stored in the index and compared everywhere. */
export function fold(s) {
  return nfc(s).toLowerCase().normalize('NFD').replace(MARKS, '').normalize('NFC');
}

/** NFC, lowercase, split on anything that is not a letter or a digit. Keeps diacritics. */
export function tokenize(s) {
  return nfc(s).toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/** Longest common prefix of two strings, compared by code points. */
export function lcp(a, b) {
  const x = [...String(a ?? '')];
  const y = [...String(b ?? '')];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i).join('');
}

function chars(s) {
  return [...s].length;
}

// ---------------------------------------------------------------------------------------------
// Stemmers: system/lang/<code>/stemmer.mjs, loaded on demand and memoized per code.

const identity = (word) => word;
const stemmerCache = new Map();

/**
 * Returns the stemmer of a language pack folder as `(word) => stem`. The word must be an NFC
 * lowercase token. 'none', an invalid code or a missing module give the identity function; a
 * module that exists but fails to load is a bug and rejects.
 */
export async function stemmer(lang) {
  const code = String(lang ?? 'none');
  if (!stemmerCache.has(code)) stemmerCache.set(code, loadStemmer(code));
  return stemmerCache.get(code);
}

async function loadStemmer(code) {
  if (code === 'none' || !LANG_CODE.test(code)) return identity;
  const url = new URL(`../lang/${code}/stemmer.mjs`, import.meta.url);
  let mod;
  try {
    mod = await import(url.href);
  } catch (err) {
    // Only the stemmer file itself may be missing; a missing dependency of it is a broken install.
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(fileURLToPath(url))) {
      return identity;
    }
    throw new Error(`stemmer ${code} failed to load: ${err?.message ?? err}`);
  }
  const fn = typeof mod.stem === 'function' ? mod.stem : mod.default;
  if (typeof fn !== 'function') throw new Error(`stemmer ${code} does not export stem(word)`);
  return (word) => {
    const out = fn(word);
    return typeof out === 'string' && out !== '' ? out : word;
  };
}

// ---------------------------------------------------------------------------------------------
// Analyzer: everything search needs from a language pack, bound to one config.

const analyzerCache = new WeakMap();

/** Returns the (memoized) analyzer for a config: stemming, query terms and the rg regex. */
export async function analyzer(cfg) {
  if (cfg && typeof cfg === 'object' && analyzerCache.has(cfg)) return analyzerCache.get(cfg);
  const lang = cfg?.lang ?? 'en';
  const stemFn = await stemmer(cfg?.pack?.stemmer ?? lang);
  const result = createAnalyzer({
    lang,
    stemFn,
    stopwords: cfg?.stopwords,
    diacriticClasses: asObject(cfg?.diacriticClasses ?? cfg?.pack?.diacritic_classes),
    asciiEndings: cfg?.asciiEndings ?? cfg?.pack?.ascii_endings,
  });
  if (cfg && typeof cfg === 'object') analyzerCache.set(cfg, result);
  return result;
}

function createAnalyzer({ lang, stemFn, stopwords, diacriticClasses, asciiEndings }) {
  const memo = new Map();
  // Endings (folded, longest first) cut from a token typed without diacritics. Stemmers of
  // languages like Czech recognize "-ím" but not "-im", so "rozhodnutim" would stay whole.
  const endings = [...new Set((Array.isArray(asciiEndings) ? asciiEndings : []).map((e) => fold(e)).filter(Boolean))]
    .sort((a, b) => chars(b) - chars(a) || (a < b ? -1 : a > b ? 1 : 0));

  // The part of a token every inflected form shares: lcp(token, stem) (section 13.3); for a
  // pure-ASCII token also the token without its longest pack ending, whichever is shorter.
  // A shared part under 4 chars (Czech "práce" → stem "prák" → "prá") would match far too much
  // ("pravidla", "zprávy"), so the first 4 chars of the token are used instead ("prác").
  function base(token) {
    return baseInfo(token).base;
  }

  function baseInfo(token) {
    const shared = lcp(token, stem(token));
    const out = chars(shared) >= MIN_PREFIX_CHARS ? shared : [...token].slice(0, MIN_PREFIX_CHARS).join('');
    if (endings.length > 0 && fold(token) === token) {
      const ending = endings.find((e) => token.endsWith(e));
      if (ending) {
        const cut = token.slice(0, token.length - ending.length);
        // One-letter endings need a longer rest, so "logo" does not shrink to "log".
        const min = MIN_ASCII_CUT + (chars(ending) === 1 ? 1 : 0);
        if (chars(cut) >= min && chars(cut) < chars(out)) return { base: cut, ascii: true };
      }
    }
    return { base: out, ascii: false };
  }
  // Stopwords match with or without diacritics ("proc" is "proč").
  const stop = new Set([...(stopwords ?? [])].map((w) => fold(w)));

  function stem(word) {
    let out = memo.get(word);
    if (out === undefined) {
      out = stemFn(word);
      memo.set(word, out);
    }
    return out;
  }

  function stems(text) {
    const seen = new Set();
    for (const token of tokenize(text)) seen.add(fold(stem(token)));
    return [...seen];
  }

  function queryTerms(q) {
    const tokens = unique(tokenize(q).filter((t) => chars(t) >= MIN_TERM_CHARS));
    const content = tokens.filter((t) => !stop.has(fold(t)));
    return (content.length > 0 ? content : tokens).map((token) => {
      const folded = fold(token);
      const info = baseInfo(token);
      const prefix = fold(info.base);
      return {
        token,
        // An ASCII base also replaces the stem: the stems column is matched as a prefix.
        stem: info.ascii ? prefix : fold(stem(token)),
        prefix,
        hadDiacritics: folded !== token,
      };
    });
  }

  // \b anchors every term at a word start, like the index does; rg's \b is Unicode-aware.
  function rgRegex(q) {
    const parts = unique(queryTerms(q).map((term) => termRegex(term, base, diacriticClasses)));
    return parts.length > 0 ? `\\b(${parts.join('|')})` : '';
  }

  return { lang, stem, stems, queryTerms, rgRegex };
}

function unique(items) {
  return [...new Set(items)];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// One alternative of the rg regex (section 13.5 of docs/architecture.md). The base is the part of
// the word the stemmer keeps unchanged, so every inflected form matches it as a plain prefix.
// Every letter with a class gets it, also in a query typed with only some accents ("pekarně"):
// a class always holds the bare letter too, so this never loses a match.
function termRegex(term, baseOf, classes) {
  let out = '';
  for (const ch of baseOf(term.token)) {
    const plain = fold(ch);
    const accented = plain !== ch;
    if (plain === '') {
      out += escapeRegex(ch);
    } else if (accented || Object.hasOwn(classes, plain)) {
      out += charClass(plain, ch, classes);
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

// '[aá]' from the pack; an accented letter the pack does not know still gets '[eë]'.
function charClass(plain, original, classes) {
  const cls = Object.hasOwn(classes, plain) ? String(classes[plain]) : '';
  if (/^\[[^\]]+\]$/.test(cls)) {
    return cls.includes(original) ? cls : `${cls.slice(0, -1)}${original}]`;
  }
  if (cls !== '') return cls;
  return plain === original ? escapeRegex(original) : `[${plain}${original}]`;
}

function escapeRegex(s) {
  return s.replace(REGEX_META, '\\$&');
}
