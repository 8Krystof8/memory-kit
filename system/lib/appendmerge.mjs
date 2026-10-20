// The merge of a note that two devices only added to: when both sides of a conflict kept every
// line of the common version and only inserted lines in the body (a new `- [fact] …` line, a
// dated gotcha, a line under a heading), the result is the common version with both sides' lines,
// the upstream side's first; the frontmatter key `updated` takes the later date. Anything else (a
// line changed or removed, a line added to the frontmatter, a heading added on both sides, an
// `updated` value without a date) is not merged here: sync then stops and lists the file.
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
  // Not in the frontmatter (a key added on both sides would be there twice), and not a heading
  // both sides add (two "## History"): those are left to the owner.
  const fmEnd = bb[0] === '---' ? bb.indexOf('---', 1) : -1;
  for (let i = 0; i <= fmEnd; i++) if (iu[i].length || ir[i].length) return null;
  const heads = (slots) => slots.flat().filter((l) => /^#{1,6}\s/.test(l));
  if (heads(iu).length && heads(ir).length) return null;
  const startsWith = (a, b) => b.length <= a.length && b.every((l, n) => a[n] === l);
  const out = [];
  for (let i = 0; i <= bb.length; i++) {
    // One side's lines may already hold the other's (it pulled them, then added more): kept once.
    if (startsWith(iu[i], ir[i])) out.push(...iu[i]);
    else if (startsWith(ir[i], iu[i])) out.push(...ir[i]);
    else out.push(...iu[i], ...ir[i]);
    if (i < bb.length) out.push(bb[i]);
  }
  // The placeholder left where the key was (inside the frontmatter, so the first one).
  const k = keys[0] >= 0 ? out.indexOf('updated:') : -1;
  if (k >= 0) {
    // Dates compared as dates: a value without one leaves the note to the owner.
    const days = dates.filter((d) => d !== null).map((d) => /\d{4}-\d{2}-\d{2}/.exec(d)?.[0] ?? null);
    if (days.some((d) => d === null)) return null;
    const latest = dates[days.indexOf([...days].sort().at(-1))];
    out[k] = `updated: ${latest}`;
  }
  const text = `${out.join('\n')}\n`;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
