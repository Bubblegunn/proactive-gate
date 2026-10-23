// Notification gate: decide, explain (support), and dry-run (policy testing).
//
// State: one append-only JSON-lines file per user under $STATE_DIR/users/.
// Every decide() appends an "intent" line (user snapshot + instant + policy).
// The outcome is never stored: it is computed by replaying the file in order,
// so the file order is the single source of truth. Concurrent workers need no
// lock because a one-write O_APPEND append is atomic, and the first line for a
// notification id is the only one that counts (retries get the same answer).

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_POLICY = Object.freeze({
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  dailyCap: 3,
});

// ---------- policy ----------

function parseHM(value, name) {
  const m = typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new TypeError(`policy.quietHours.${name} must be "HH:MM", got ${JSON.stringify(value)}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 60;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('policy must be an object');
  const { quietHours, dailyCap } = policy;
  let quiet = null;
  if (quietHours !== null) {
    if (!quietHours || typeof quietHours !== 'object') {
      throw new TypeError('policy.quietHours must be { start, end } or null');
    }
    quiet = {
      start: quietHours.start,
      end: quietHours.end,
      s: parseHM(quietHours.start, 'start'),
      e: parseHM(quietHours.end, 'end'),
    };
  }
  if (dailyCap !== null && !(Number.isInteger(dailyCap) && dailyCap >= 0)) {
    throw new TypeError('policy.dailyCap must be a non-negative integer or null');
  }
  return { quiet, cap: dailyCap };
}

// A window with start == end is empty. start > end wraps over midnight. [start, end).
function inWindow(sec, q) {
  if (q.s === q.e) return false;
  return q.s < q.e ? sec >= q.s && sec < q.e : sec >= q.s || sec < q.e;
}

// ---------- local time ----------

const formatters = new Map();
function formatterFor(tz) {
  if (typeof tz !== 'string' || tz === '') throw new RangeError('invalid time zone');
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(ms, tz) {
  const o = {};
  for (const p of formatterFor(tz).formatToParts(ms)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

const wallMs = (p) => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
const offsetMs = (ms, tz) => wallMs(localParts(ms, tz)) - Math.floor(ms / 1000) * 1000;
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;

function nextDate(p) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// Local wall time -> UTC ms. Ambiguous (clocks go back): earlier instant.
// Missing (clocks go forward): first instant after the gap.
function zonedToUtc(day, seconds, tz) {
  const wall = Date.UTC(day.y, day.mo - 1, day.d) + seconds * 1000;
  const before = wall - offsetMs(wall - 864e5, tz);
  const after = wall - offsetMs(wall + 864e5, tz);
  const ok = [before, after].filter((t) => wallMs(localParts(t, tz)) === wall);
  return ok.length ? Math.min(...ok) : before;
}

function fmtLocal(ms, tz) {
  const p = localParts(ms, tz);
  return `${keyOf(p)} ${pad(p.h)}:${pad(p.mi)}`;
}

// ---------- the rules (shared by decide and dryRun) ----------

// Earliest instant the notification could have gone out, given the counts we know.
function earliestDelivery(nowMs, tz, p, policy, countOn, quiet) {
  const { quiet: q, cap } = policy;
  if (cap === 0) return null;
  let t = nowMs;
  if (quiet) {
    const today = zonedToUtc(p, q.e, tz);
    t = today > nowMs ? today : zonedToUtc(nextDate(p), q.e, tz);
  }
  for (let i = 0; i < 366; i++) {
    const lp = localParts(t, tz);
    if (cap === null || countOn(keyOf(lp)) < cap) return new Date(t).toISOString();
    const day = nextDate(lp);
    t = zonedToUtc(day, q && inWindow(0, q) ? q.e : 0, tz);
  }
  return null;
}

// Rule order: consent, time zone, quiet hours, daily cap.
function evaluate({ tz, consent, nowMs, policy, countOn }) {
  if (consent !== true) return { send: false, ruleCode: 'NO_CONSENT', availableAt: null, date: null };
  let p;
  try {
    p = localParts(nowMs, tz);
  } catch {
    return { send: false, ruleCode: 'INVALID_TIMEZONE', availableAt: null, date: null };
  }
  const date = keyOf(p);
  const quiet = policy.quiet !== null && inWindow(p.h * 3600 + p.mi * 60 + p.s, policy.quiet);
  const capped = !quiet && policy.cap !== null && countOn(date) >= policy.cap;
  if (!quiet && !capped) return { send: true, ruleCode: null, availableAt: null, date };
  return {
    send: false,
    ruleCode: quiet ? 'QUIET_HOURS' : 'DAILY_CAP',
    availableAt: earliestDelivery(nowMs, tz, p, policy, countOn, quiet),
    date,
  };
}

function explain({ tz, nowMs, policy }, r) {
  const when = (iso) => ` and the earliest it could have been delivered was ${fmtLocal(Date.parse(iso), tz)} (${tz} time)`;
  const tail = r.availableAt ? when(r.availableAt) : '';
  switch (r.ruleCode) {
    case null:
      return `This notification was delivered at ${fmtLocal(nowMs, tz)} (${tz} time).`;
    case 'NO_CONSENT':
      return 'You did not receive this notification because we have no consent from you to send notifications, so none can be sent until you opt in.';
    case 'INVALID_TIMEZONE':
      return `You did not receive this notification because the time zone on your account (${JSON.stringify(tz ?? null)}) is not valid, so we could not tell whether it was a suitable time to send.`;
    case 'QUIET_HOURS':
      return `You did not receive this notification because it was triggered at ${fmtLocal(nowMs, tz)} (${tz} time), inside quiet hours (${policy.quiet.start} to ${policy.quiet.end}),${tail || ' and it cannot be known when it could have been delivered'}.`;
    case 'DAILY_CAP':
      return `You did not receive this notification because you had already received the daily maximum of ${policy.cap} notifications on ${r.date} (${tz} time),${tail || ' and it cannot be known when it could have been delivered'}.`;
    default:
      return 'You did not receive this notification.';
  }
}

// ---------- state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.resolve(dir);
}

const fileFor = (userId) =>
  path.join(stateDir(), 'users', createHash('sha256').update(String(userId)).digest('hex') + '.jsonl');

async function appendLine(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, 'a');
  try {
    // Leading newline isolates this line from any torn line left by a crashed writer.
    await fh.write(`\n${JSON.stringify(obj)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Replays a user's file; returns decisions in the order considered, one per notification.
async function replay(userId) {
  let raw;
  try {
    raw = await readFile(fileFor(userId), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const seen = new Set();
  const counts = new Map();
  const countOn = (d) => counts.get(d) ?? 0;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.v !== 1 || typeof rec.notificationId !== 'string' || seen.has(rec.notificationId)) continue;
    let policy;
    const atMs = Date.parse(rec.at);
    try {
      policy = normalizePolicy(rec.policy);
    } catch {
      continue;
    }
    if (Number.isNaN(atMs)) continue;
    seen.add(rec.notificationId);
    const ctx = { tz: rec.timezone, consent: rec.consent, nowMs: atMs, policy };
    const r = evaluate({ ...ctx, countOn });
    if (r.send) counts.set(r.date, countOn(r.date) + 1);
    out.push({ notificationId: rec.notificationId, atMs, ctx, r });
  }
  return out;
}

// ---------- API ----------

const idOf = (v, name) => {
  if ((typeof v === 'string' && v !== '') || Number.isFinite(v)) return String(v);
  throw new TypeError(`${name} is required`);
};

export async function decide({ user, notification, now }) {
  const userId = idOf(user?.id, 'user.id');
  const notificationId = idOf(notification?.id, 'notification.id');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const find = (list) => list.find((d) => d.notificationId === notificationId);
  let hit = find(await replay(userId));
  if (!hit) {
    await appendLine(fileFor(userId), {
      v: 1,
      userId,
      notificationId,
      at: now.toISOString(),
      timezone: user.timezone ?? null,
      consent: user.consent === true,
      policy: DEFAULT_POLICY,
    });
    hit = find(await replay(userId));
  }
  return { send: hit.r.send };
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new TypeError('from and to must be ISO 8601 strings');
  return (await replay(idOf(userId, 'userId')))
    .filter((d) => d.atMs >= fromMs && d.atMs < toMs)
    .map((d) => ({
      notificationId: d.notificationId,
      at: new Date(d.atMs).toISOString(),
      delivered: d.r.send,
      ruleCode: d.r.ruleCode,
      availableAt: d.r.availableAt,
      text: explain(d.ctx, d.r),
    }));
}

// Pure simulation: reads and writes no state.
export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const items = events.map((ev, i) => {
    const atMs = Date.parse(ev?.at);
    if (Number.isNaN(atMs)) throw new TypeError(`events[${i}].at must be an ISO 8601 string`);
    return { userId: idOf(ev.user?.id, `events[${i}].user.id`), nid: idOf(ev.notification?.id, `events[${i}].notification.id`), user: ev.user, atMs, i };
  });
  items.sort((a, b) => a.atMs - b.atMs || a.i - b.i);

  const perUser = new Map();
  let delivered = 0;
  let blocked = 0;
  for (const it of items) {
    let st = perUser.get(it.userId);
    if (!st) perUser.set(it.userId, (st = { counts: new Map(), seen: new Map() }));
    let send = st.seen.get(it.nid); // repeated notification id: first outcome stands
    if (send === undefined) {
      const countOn = (d) => st.counts.get(d) ?? 0;
      const r = evaluate({ tz: it.user.timezone, consent: it.user.consent === true, nowMs: it.atMs, policy: pol, countOn });
      send = r.send;
      if (send) st.counts.set(r.date, countOn(r.date) + 1);
      st.seen.set(it.nid, send);
    }
    if (send) delivered++;
    else blocked++;
  }
  return { delivered, blocked };
}
