// The merge of a note that two devices only added to: when both sides of a conflict kept every
// line of the common version and only inserted lines (a new `- [fact] …` line, a dated gotcha, a
// line under a heading), the result is the common version with both sides' lines, the upstream
// side's first; the frontmatter key `updated` takes the later date. Anything else (a line changed
// or removed on either side) is not merged here: sync then stops and lists the file, as before.
// Pure: text in, text or null out.

const UPDATED = /^updated:\s*(\S.*)$/;

const lines = (text) => {
  const s = String(text).replace(/\r\n/g, '\n');
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};

/** The line index of the frontmatter's `updated:` key, or -1. */
function updatedAt(list) {
  if (list[0] !== '---') return -1;
  for (let i = 1; i < list.length && list[i] !== '---'; i++) if (UPDATED.test(list[i])) return i;
  return -1;
}

/**
 * The lines a side inserted before each line of base (index base.length: at the end), or null
 * when base is not kept whole and in order in side.
 */
function insertions(base, side) {
  const out = Array.from({ length: base.length + 1 }, () => []);
  let j = 0;
  for (let i = 0; i < base.length; i++) {
    const at = side.indexOf(base[i], j);
    if (at < 0) return null;
    out[i].push(...side.slice(j, at));
    j = at + 1;
  }
  out[base.length].push(...side.slice(j));
  return out;
}

/**
 * The merged text of a note both sides only added to, or null. base, upstream and replayed are
 * the three versions of the conflict (git stages 1, 2 and 3 during a rebase).
 */
export function mergeAdditions(base, upstream, replayed) {
  if ([base, upstream, replayed].some((t) => typeof t !== 'string')) return null;
  const crlf = /\r\n/.test(upstream);
  const [b, u, r] = [lines(base), lines(upstream), lines(replayed)];
  // The `updated` dates may differ on every side: compared without them, merged to the latest.
  const keys = [b, u, r].map(updatedAt);
  const dates = keys.map((k, n) => (k >= 0 ? UPDATED.exec([b, u, r][n][k])[1].trim() : null));
  // Only a key the common version has is compared without its date; one a side adds is a line.
  const blank = (list, k) => (k >= 0 && keys[0] >= 0 ? list.map((l, i) => (i === k ? 'updated:' : l)) : list);
  const [bb, ub, rb] = [blank(b, keys[0]), blank(u, keys[1]), blank(r, keys[2])];
  const iu = insertions(bb, ub);
  const ir = insertions(bb, rb);
  if (!iu || !ir) return null;
  const out = [];
  for (let i = 0; i <= bb.length; i++) {
    out.push(...iu[i]);
    // The same lines added on both sides are kept once.
    if (ir[i].join('\n') !== iu[i].join('\n')) out.push(...ir[i]);
    if (i < bb.length) out.push(bb[i]);
  }
  // The placeholder left where the key was (inside the frontmatter, so the first one).
  const k = keys[0] >= 0 ? out.indexOf('updated:') : -1;
  if (k >= 0) {
    const latest = dates.filter(Boolean).sort().at(-1);
    out[k] = latest ? `updated: ${latest}` : b[keys[0]] ?? out[k];
  }
  const text = `${out.join('\n')}\n`;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
