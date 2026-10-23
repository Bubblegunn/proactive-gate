// Notification gate: consent, quiet hours, daily cap. No dependencies.
// State: STATE_DIR/users/<sha256(userId)>.jsonl, one JSON line per considered notification,
// guarded by a per-user lock directory so several worker processes can share it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

// ---------- time helpers ----------

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

// Local wall-clock parts of an instant in tz.
function localParts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Instant at which the wall clock in tz reads y-mo-d h:mi (first such instant; shifted forward in a DST gap).
function localToInstant(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  const t2 = guess - offsetAt(t, tz);
  if (t2 !== t) {
    const t3 = guess - offsetAt(t2, tz);
    t = t3 === t2 ? t2 : Math.min(t, t2);
  }
  return t;
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
const clock = (p) => `${pad(p.h)}:${pad(p.mi)}`;

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`invalid time "${s}", expected HH:MM`);
  return +m[1] * 60 + +m[2];
}

function parseInstant(v, what) {
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`invalid ${what}: ${v}`);
  return ms;
}

function normalizePolicy(policy) {
  if (policy === null || typeof policy !== 'object') throw new Error('policy must be an object');
  const { quietHours = null, dailyCap = null } = policy;
  let q = null;
  if (quietHours !== null) {
    q = { start: parseHHMM(quietHours.start), end: parseHHMM(quietHours.end) };
    if (q.start === q.end) q = null; // empty window
  }
  if (dailyCap !== null && !(Number.isInteger(dailyCap) && dailyCap >= 0)) {
    throw new Error('dailyCap must be a non-negative integer or null');
  }
  return { quietHours: q, dailyCap };
}

function inQuiet(q, minuteOfDay) {
  if (!q) return false;
  return q.start < q.end
    ? minuteOfDay >= q.start && minuteOfDay < q.end
    : minuteOfDay >= q.start || minuteOfDay < q.end;
}

// ---------- the rule engine (shared by decide and dryRun) ----------

// deliveredMs: instants already delivered for this user. Returns an outcome without side effects.
function evaluate({ consent, timezone }, atMs, policy, deliveredMs) {
  if (consent !== true) return { delivered: false, ruleCode: 'NO_CONSENT', availableMs: null };
  if (!validTimezone(timezone)) return { delivered: false, ruleCode: 'INVALID_TIMEZONE', availableMs: null };
  const p = localParts(atMs, timezone);
  const minute = p.h * 60 + p.mi;

  if (inQuiet(policy.quietHours, minute)) {
    // Earliest moment after the quiet window: the next local occurrence of its end time.
    const e = policy.quietHours.end;
    let c = localToInstant(timezone, p.y, p.mo, p.d, Math.floor(e / 60), e % 60);
    if (c <= atMs) {
      const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
      c = localToInstant(timezone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), Math.floor(e / 60), e % 60);
    }
    return { delivered: false, ruleCode: 'QUIET_HOURS', availableMs: c };
  }

  if (policy.dailyCap !== null) {
    const today = dayKey(p);
    let count = 0;
    for (const ms of deliveredMs) if (dayKey(localParts(ms, timezone)) === today) count++;
    if (count >= policy.dailyCap) {
      // Cap resets at the next local midnight; if that moment is quiet, wait for the quiet window to end.
      const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
      const ny = next.getUTCFullYear(), nm = next.getUTCMonth() + 1, nd = next.getUTCDate();
      let c = localToInstant(timezone, ny, nm, nd, 0, 0);
      const q = policy.quietHours;
      if (q && inQuiet(q, 0)) c = localToInstant(timezone, ny, nm, nd, Math.floor(q.end / 60), q.end % 60);
      return { delivered: false, ruleCode: 'DAILY_CAP', availableMs: c, count };
    }
  }
  return { delivered: true, ruleCode: null, availableMs: null };
}

function explain(out, tz, atMs, policy) {
  const p = tz && validTimezone(tz) ? localParts(atMs, tz) : null;
  const when = p ? `${dayKey(p)} ${clock(p)}` : null;
  const later = (ms) => {
    if (ms === null || !p) return '';
    const l = localParts(ms, tz);
    return `; it could have been delivered from ${dayKey(l)} ${clock(l)} your local time`;
  };
  const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  switch (out.ruleCode) {
    case null:
      return `This notification was delivered at ${when} your local time (${tz}).`;
    case 'NO_CONSENT':
      return 'We did not send this notification because we do not have your consent to send you notifications.';
    case 'INVALID_TIMEZONE':
      return `We did not send this notification because the time zone on your account ("${tz}") is not valid, so we cannot tell what time it is for you.`;
    case 'QUIET_HOURS': {
      const q = policy.quietHours;
      return `We did not send this notification because it was ready at ${when} your local time (${tz}), which is inside quiet hours (${hhmm(q.start)} to ${hhmm(q.end)})${later(out.availableMs)}.`;
    }
    case 'DAILY_CAP':
      return `We did not send this notification because you had already received ${out.count} notifications on ${dayKey(p)} (your local day), which is the daily limit of ${policy.dailyCap}${later(out.availableMs)}.`;
    default:
      return 'We did not send this notification.';
  }
}

// ---------- shared state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const dir = path.join(stateDir(), 'users');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash('sha256').update(String(userId)).digest('hex') + '.jsonl');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function withLock(file, fn) {
  const lock = file + '.lock';
  const deadline = Date.now() + 30000;
  for (let wait = 1; ; wait = Math.min(wait * 2, 25)) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(path.join(lock, 'owner'), String(process.pid)); } catch { /* lock still held */ }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Recover a lock left by a crashed process.
      let stale = false;
      try {
        const pid = parseInt(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 10);
        stale = Number.isInteger(pid) ? !pidAlive(pid) : false;
      } catch {
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10000; } catch { /* just released */ }
      }
      if (stale) {
        const trash = `${lock}.stale.${process.pid}.${Date.now()}`;
        try { fs.renameSync(lock, trash); fs.rmSync(trash, { recursive: true, force: true }); } catch { /* lost the race */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the user state lock');
      await sleep(wait + Math.random() * wait);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function readRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { records: [], text: '' }; throw e; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn write from a crash */ }
  }
  return { records, text };
}

function appendRecord(file, text, rec) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(rec) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  const atMs = parseInstant(now, 'now');
  const file = userFile(user.id);
  const policy = normalizePolicy(DEFAULT_POLICY);
  return withLock(file, async () => {
    const { records, text } = readRecords(file);
    const key = String(notification.id);
    // A retry of the same notification gets the original answer and is not counted twice.
    const prior = records.find((r) => r.k === key);
    if (prior) return { send: prior.d };

    const out = evaluate(user, atMs, policy, records.filter((r) => r.d).map((r) => Date.parse(r.at)));
    appendRecord(file, text, {
      k: key,
      n: notification.id,
      at: new Date(atMs).toISOString(),
      d: out.delivered,
      rc: out.ruleCode,
      av: out.availableMs === null ? null : new Date(out.availableMs).toISOString(),
      tz: user.timezone,
      tx: explain(out, user.timezone, atMs, policy),
    });
    return { send: out.delivered };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = parseInstant(from, 'from');
  const toMs = parseInstant(to, 'to');
  const { records } = readRecords(userFile(userId));
  return records
    .filter((r) => { const t = Date.parse(r.at); return t >= fromMs && t < toMs; })
    .map((r) => ({
      notificationId: r.n,
      at: r.at,
      delivered: r.d,
      ruleCode: r.rc,
      availableAt: r.av,
      text: r.tx,
    }));
}

export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  const items = events.map((e, i) => ({ e, i, ms: parseInstant(e.at, 'event.at') }));
  items.sort((a, b) => a.ms - b.ms || a.i - b.i);
  const perUser = new Map(); // userId -> { delivered: ms[], seen: Map(notificationId -> bool) }; memory only
  let delivered = 0, blocked = 0;
  for (const { e, ms } of items) {
    const uid = String(e.user.id);
    let st = perUser.get(uid);
    if (!st) perUser.set(uid, (st = { delivered: [], seen: new Map() }));
    const key = String(e.notification.id);
    let ok = st.seen.get(key);
    if (ok === undefined) {
      ok = evaluate(e.user, ms, pol, st.delivered).delivered;
      st.seen.set(key, ok);
      if (ok) st.delivered.push(ms);
    }
    if (ok) delivered++; else blocked++;
  }
  return { delivered, blocked };
}
