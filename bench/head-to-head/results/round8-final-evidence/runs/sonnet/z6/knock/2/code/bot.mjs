import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Current production policy.
const DEFAULT_POLICY = Object.freeze({
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  dailyCap: 3,
});

// ---------- time helpers ----------

const fmtCache = new Map();
function partsOf(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o; // year, month, day, hour, minute, second (local)
}

function offsetMs(ms, tz) {
  const p = partsOf(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Local wall-clock time in tz -> UTC ms. Day overflow (d+1) is allowed.
function localToUtc(y, m, d, hh, mm, tz) {
  const g = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetMs(g, tz);
  let r = g - o1;
  const o2 = offsetMs(r, tz);
  if (o2 !== o1) r = g - o2;
  return r;
}

function dayKey(ms, tz) {
  const p = partsOf(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function parseHM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`invalid time "${s}", expected HH:MM`);
  return { h: +m[1], m: +m[2], min: +m[1] * 60 + +m[2] };
}

function validateTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('policy is required');
  const q = policy.quietHours ?? null;
  const cap = policy.dailyCap ?? null;
  if (cap !== null && (typeof cap !== 'number' || !(cap >= 0))) throw new Error('dailyCap must be a number or null');
  return { quiet: q ? { start: parseHM(q.start), end: parseHM(q.end), raw: q } : null, cap };
}

function inQuiet(min, quiet) {
  if (!quiet) return false;
  const s = quiet.start.min, e = quiet.end.min;
  if (s === e) return false;
  return s < e ? min >= s && min < e : min >= s || min < e;
}

// First instant strictly after ms at which local time equals the quiet end.
function quietEndAfter(ms, tz, quiet) {
  const p = partsOf(ms, tz);
  let c = localToUtc(p.year, p.month, p.day, quiet.end.h, quiet.end.m, tz);
  if (c <= ms) c = localToUtc(p.year, p.month, p.day + 1, quiet.end.h, quiet.end.m, tz);
  return c;
}

function nextLocalMidnight(ms, tz) {
  const p = partsOf(ms, tz);
  return localToUtc(p.year, p.month, p.day + 1, 0, 0, tz);
}

// ---------- pure policy evaluation ----------

// deliveredMs: instants (ms) of earlier delivered notifications for this user.
function evaluate({ user, atMs, pol, deliveredMs }) {
  if (user.consent !== true) return { send: false, ruleCode: 'NO_CONSENT', availableAt: null };
  if (typeof user.timezone !== 'string' || !validateTz(user.timezone)) {
    return { send: false, ruleCode: 'INVALID_TIMEZONE', availableAt: null };
  }
  const tz = user.timezone;
  const p = partsOf(atMs, tz);
  const quietNow = inQuiet(p.hour * 60 + p.minute, pol.quiet);
  const today = dayKey(atMs, tz);
  const used = deliveredMs.filter((t) => dayKey(t, tz) === today).length;
  const capHit = pol.cap !== null && used >= pol.cap;
  if (!quietNow && !capHit) return { send: true, ruleCode: null, availableAt: null };

  const ruleCode = quietNow ? 'QUIET_HOURS' : 'DAILY_CAP';
  // Earliest instant at which it would have passed. All known deliveries are <= atMs,
  // so only the day of atMs can be capped.
  let availableAt = null;
  if (!(pol.cap !== null && pol.cap <= 0)) {
    let t = atMs;
    let capActive = capHit;
    for (let i = 0; i < 4; i++) {
      const q = partsOf(t, tz);
      if (inQuiet(q.hour * 60 + q.minute, pol.quiet)) { t = quietEndAfter(t, tz, pol.quiet); continue; }
      if (capActive && dayKey(t, tz) === today) { t = nextLocalMidnight(t, tz); capActive = false; continue; }
      availableAt = t;
      break;
    }
  }
  return { send: false, ruleCode, availableAt: availableAt === null ? null : new Date(availableAt).toISOString() };
}

// ---------- persistent state (JSONL per user, guarded by a lock directory) ----------

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}

function userBase(userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
  return path.join(stateDir(), `user-${h}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_STALE_MS = 15000;

async function withLock(base, fn) {
  const lock = `${base}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 30000;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const tomb = `${lock}.stale-${randomUUID()}`;
          await fs.rename(lock, tomb); // only one contender wins the rename
          await fs.rm(tomb, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished or was taken over; retry */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for state lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function readEntries(base) {
  let raw;
  try { raw = await fs.readFile(`${base}.jsonl`, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn trailing write */ }
  }
  return out;
}

// ---------- API ----------

export async function decide({ user, notification, now }) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error('invalid now');
  const pol = normalizePolicy(DEFAULT_POLICY);
  const base = userBase(user.id);
  return withLock(base, async () => {
    const entries = await readEntries(base);
    // A retry of an already delivered notification must not be counted twice.
    if (entries.some((e) => e.notificationId === notification.id && e.delivered)) return { send: true };
    const deliveredMs = entries.filter((e) => e.delivered).map((e) => Date.parse(e.at));
    const r = evaluate({ user, atMs: at.getTime(), pol, deliveredMs });
    const entry = {
      notificationId: notification.id,
      at: at.toISOString(),
      delivered: r.send,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt,
      timezone: user.timezone,
    };
    await fs.appendFile(`${base}.jsonl`, JSON.stringify(entry) + '\n');
    return { send: r.send };
  });
}

function localLabel(iso, tz) {
  const p = partsOf(Date.parse(iso), tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}`;
}

function explain(e) {
  const tz = e.timezone;
  const okTz = typeof tz === 'string' && validateTz(tz);
  const when = okTz ? `${localLabel(e.at, tz)} (${tz})` : `${e.at} (UTC)`;
  const avail = e.availableAt ? (okTz ? `${localLabel(e.availableAt, tz)} (${tz})` : `${e.availableAt} (UTC)`) : null;
  const tail = avail ? `it could have been delivered from ${avail}` : 'it cannot be delivered automatically later';
  switch (e.ruleCode) {
    case null: return `This notification was delivered at ${when}.`;
    case 'NO_CONSENT': return `This notification was not delivered at ${when} because the account has not given consent to receive notifications.`;
    case 'QUIET_HOURS': return `This notification was not delivered at ${when} because it fell in quiet hours (22:00 to 08:00 local time), and ${tail}.`;
    case 'DAILY_CAP': return `This notification was not delivered at ${when} because the maximum of 3 notifications for that local day had already been delivered, and ${tail}.`;
    case 'INVALID_TIMEZONE': return `This notification was not delivered at ${when} because the timezone on the account is missing or invalid, so local time rules could not be applied.`;
    default: return `This notification was not delivered at ${when} (rule ${e.ruleCode}).`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const f = Date.parse(from), t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) throw new Error('from and to must be ISO 8601 strings');
  const base = userBase(userId);
  // Take the lock so we never read mid-append.
  const entries = await withLock(base, () => readEntries(base));
  return entries
    .filter((e) => {
      const ms = Date.parse(e.at);
      return ms >= f && ms < t;
    })
    .map((e) => ({
      notificationId: e.notificationId,
      at: e.at,
      delivered: e.delivered,
      ruleCode: e.ruleCode,
      availableAt: e.availableAt,
      text: explain(e),
    }));
}

export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  const items = events
    .map((ev, i) => ({ ev, i, ms: Date.parse(ev.at) }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const perUser = new Map(); // in-memory only
  let delivered = 0, blocked = 0;
  for (const { ev, ms } of items) {
    if (Number.isNaN(ms)) throw new Error(`invalid event time "${ev.at}"`);
    let st = perUser.get(ev.user.id);
    if (!st) perUser.set(ev.user.id, (st = { deliveredMs: [], ids: new Set() }));
    if (st.ids.has(ev.notification.id)) { delivered++; continue; }
    const r = evaluate({ user: ev.user, atMs: ms, pol, deliveredMs: st.deliveredMs });
    if (r.send) { st.deliveredMs.push(ms); st.ids.add(ev.notification.id); delivered++; } else blocked++;
  }
  return { delivered, blocked };
}
