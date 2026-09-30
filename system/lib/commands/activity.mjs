// `activity`: what the agents did with the memory on this computer (docs/architecture.md, 10.10),
// from the activity log (lib/activity.mjs) and the hook log (lib/hooklog.mjs): the last use, the
// counts of today and of the last days, who used it, the notes used most and the latest uses. It
// answers "does the memory work at all?" without a session, and says which kit this is, whether a
// newer one is known (lib/updates.mjs: from the last check, no network) and how the owner hears of
// the next one. Reads the clock (for "today" and the ages); writes nothing. Exit 0, also when
// nothing is recorded yet.

import { ACTIVITY_OPS, ACTIVITY_REL, activityOn, readActivity, summarizeActivity } from '../activity.mjs';
import { readHookLog } from '../hooklog.mjs';
import { channelList, updateStatus } from '../updates.mjs';
import { parseCli, usageError } from '../util.mjs';

export const usage = 'activity [--days 7] [--json]';

// English defaults; packs may translate the same keys.
const DEFAULTS = {
  'activity.title': 'Memory activity on this computer · last {days} days',
  'activity.last': 'Last use: {ago} · {who} · {what}',
  'activity.never': 'No use of the memory is recorded on this computer yet.',
  'activity.empty_hint': 'It fills in when an agent uses the memory: a session start through a hook, a search, a note read or saved. Nothing after a session? Check the connections: {cmd} doctor',
  'activity.today': 'Today: {counts}',
  'activity.period': 'Last {days} days: {counts}',
  'activity.nothing': 'nothing',
  'activity.who': 'Who: {list}',
  'activity.notes': 'Notes used most: {list}',
  'activity.latest': 'Latest:',
  'activity.hooks': 'Project hooks: last run {ago} ({event}, {result}) · failed runs in 7 days: {n}',
  'activity.hooks_ok': 'ok',
  'activity.hooks_failed': 'failed',
  'activity.footer': 'The log stays on this computer ({file}; never committed, no query text). Turn it off: "feedback": {"log": false} in memory.json',
  'activity.off': 'The activity log is off ("feedback": {"log": false} in memory.json), so nothing new is recorded. Turn it on: set "log" to true.',
  'activity.not_set_up': 'This memory is not set up yet (memory.json "initialized": false), so nothing is recorded.',
  'activity.op_start': 'session start',
  'activity.op_search': 'search',
  'activity.op_read': 'note read',
  'activity.op_recent': 'recent notes',
  'activity.op_save': 'saved',
  'activity.op_lookup': 'error lookup',
  'activity.count_start': 'session starts {n}',
  'activity.count_search': 'searches {n}',
  'activity.count_read': 'notes read {n}',
  'activity.count_recent': 'recent lists {n}',
  'activity.count_save': 'saved {n}',
  'activity.count_lookup': 'error lookups {n}',
  'activity.results': '{n} results',
  'activity.project': 'project {id}',
  'activity.local': '+{n} in local sectors',
  'activity.ago_now': 'just now',
  'activity.ago_min': '{n} min ago',
  'activity.ago_h': '{n} h ago',
  'activity.ago_days': '{n} days ago',
  'activity.cli': 'CLI',
  'activity.mcp': '{name} (MCP)',
  'activity.mcp_unknown': 'an app (MCP)',
  'activity.bad_days': '--days must be a whole number from 1 to 365, got "{value}"',
  'activity.kit_newer': 'Kit: {installed} · {latest} is out (checked {ago}): {cmd} upgrade',
  'activity.kit_current': 'Kit: {installed}, the newest (checked {ago})',
  'activity.kit_unknown': 'Kit: {installed} · not checked for a newer one yet: {cmd} upgrade --check',
  'activity.channels': 'New versions: {list}',
};

// Product names are not translated.
const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
const MAX_DAYS = 365;
const MAX_WHO = 5;

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (a, n) => (n in vars ? String(vars[n]) : a));
}

/** "3 min ago", "5 h ago", "2 days ago" of an ISO time. */
export function ago(cfg, t, now = new Date()) {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(t)) / 60000));
  if (min < 1) return say(cfg, 'activity.ago_now');
  if (min < 60) return say(cfg, 'activity.ago_min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return say(cfg, 'activity.ago_h', { n: h });
  return say(cfg, 'activity.ago_days', { n: Math.floor(h / 24) });
}

/** Who used the memory, as the owner reads it: "Claude Code", "claude-ai (MCP)", "CLI". */
export function whoName(cfg, agent, via) {
  const name = agent ? AGENT_NAMES[agent] ?? agent : null;
  if (via === 'mcp') return name ? say(cfg, 'activity.mcp', { name }) : say(cfg, 'activity.mcp_unknown');
  return name ?? say(cfg, 'activity.cli');
}

/** One use: "search · 4 results · sectors/work/pricing.md" (the notes it named, a project, local ones). */
function what(cfg, e) {
  const parts = [say(cfg, `activity.op_${e.op}`)];
  if (Number.isInteger(e.n) && (e.op === 'search' || e.op === 'lookup' || e.op === 'recent')) parts.push(say(cfg, 'activity.results', { n: e.n }));
  if (e.project) parts.push(say(cfg, 'activity.project', { id: e.project }));
  if (Array.isArray(e.notes) && e.notes.length) parts.push(e.notes.slice(0, e.op === 'search' ? 1 : 3).join(', '));
  if (Number.isInteger(e.local) && e.local > 0) parts.push(say(cfg, 'activity.local', { n: e.local }));
  return parts.join(' · ');
}

/**
 * "Claude Code 5 · claude-ai (MCP) 3": the uses per name the owner reads, most first. The CLI and
 * the project hooks of one agent are one name; an MCP app keeps its own.
 */
function whoList(cfg, who) {
  const byName = new Map();
  for (const w of who) {
    const name = whoName(cfg, w.agent, w.via);
    byName.set(name, (byName.get(name) ?? 0) + w.n);
  }
  return [...byName].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_WHO).map(([name, n]) => `${name} ${n}`).join(' · ');
}

function counts(cfg, byOp) {
  const list = ACTIVITY_OPS.filter((op) => byOp[op] > 0).map((op) => say(cfg, `activity.count_${op}`, { n: byOp[op] }));
  return list.length ? list.join(' · ') : say(cfg, 'activity.nothing');
}

/** The report of `activity --json`: the summary, whether the log is on, and the project hooks. */
export function activityReport(cfg, { days = 7, now = new Date() } = {}) {
  const summary = summarizeActivity(readActivity(cfg.root), { now, days });
  const hooks = readHookLog(cfg.root);
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const last = hooks.length ? hooks[hooks.length - 1] : null;
  return {
    ...summary,
    log: { on: activityOn(cfg), off: cfg.initialized !== true ? 'not_set_up' : cfg.feedback?.log === false ? 'off' : null, file: ACTIVITY_REL },
    hooks: {
      last: last ? { t: last.t, event: last.event ?? null, ok: last.ok !== false } : null,
      failures: hooks.filter((e) => e.ok === false && e.t >= since).length,
    },
    updates: updateStatus(cfg),
  };
}

export function formatActivity(cfg, report, { now = new Date(), cmd = 'node system/memory.mjs' } = {}) {
  const lines = [say(cfg, 'activity.title', { days: report.days })];
  if (report.log.off) lines.push(say(cfg, `activity.${report.log.off}`));
  if (!report.last) {
    lines.push(say(cfg, 'activity.never'));
    if (!report.log.off) lines.push(say(cfg, 'activity.empty_hint', { cmd }));
  } else {
    const e = report.last;
    lines.push(say(cfg, 'activity.last', { ago: ago(cfg, e.t, now), who: whoName(cfg, e.agent, e.via), what: what(cfg, e) }));
    lines.push(say(cfg, 'activity.today', { counts: counts(cfg, report.today) }));
    lines.push(say(cfg, 'activity.period', { days: report.days, counts: counts(cfg, report.period) }));
    if (report.who.length) lines.push(say(cfg, 'activity.who', { list: whoList(cfg, report.who) }));
    if (report.notes.length) lines.push(say(cfg, 'activity.notes', { list: report.notes.map((n) => `${n.rel} ${n.n}`).join(' · ') }));
    if (report.latest.length) {
      lines.push(say(cfg, 'activity.latest'));
      for (const l of report.latest) lines.push(`- ${ago(cfg, l.t, now)} · ${whoName(cfg, l.agent, l.via)} · ${what(cfg, l)}`);
    }
  }
  if (report.hooks.last) {
    const h = report.hooks.last;
    lines.push(say(cfg, 'activity.hooks', {
      ago: ago(cfg, h.t, now), event: h.event ?? '?', result: say(cfg, h.ok ? 'activity.hooks_ok' : 'activity.hooks_failed'), n: report.hooks.failures,
    }));
  }
  const u = report.updates;
  if (u?.installed) {
    const vars = { installed: u.installed, latest: u.latest, cmd, ago: u.checked ? ago(cfg, u.checked, now) : '' };
    lines.push(say(cfg, u.available ? 'activity.kit_newer' : u.checked ? 'activity.kit_current' : 'activity.kit_unknown', vars));
    lines.push(say(cfg, 'activity.channels', { list: channelList(cfg, u) }));
  }
  if (report.log.on) lines.push(say(cfg, 'activity.footer', { file: report.log.file }));
  return `${lines.join('\n')}\n`;
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, { days: { type: 'string' }, json: { type: 'boolean' } }, usage);
  if (!parsed) return 2;
  if (parsed.positionals.length) {
    usageError(`unexpected argument "${parsed.positionals[0]}"`, usage);
    return 2;
  }
  const raw = parsed.values.days ?? '7';
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 1 && days <= MAX_DAYS)) {
    usageError(say(cfg, 'activity.bad_days', { value: raw }), usage);
    return 2;
  }
  const now = new Date();
  const report = activityReport(cfg, { days, now });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatActivity(cfg, report, { now, cmd: 'node system/memory.mjs' }));
  return 0;
}
