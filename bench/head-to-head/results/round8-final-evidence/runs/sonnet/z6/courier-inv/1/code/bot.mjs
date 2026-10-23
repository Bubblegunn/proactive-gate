// Notification gate: consent, quiet hours (local time), daily cap (local calendar day).
// State lives in STATE_DIR: one append-only JSONL log per user, guarded by a lock directory,
// so it survives restarts and is safe with several worker processes.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_POLICY = { quietHours: { start: "22:00", end: "08:00" }, dailyCap: 3 };

export const RULES = {
  NO_CONSENT: "NO_CONSENT",
  QUIET_HOURS: "QUIET_HOURS",
  DAILY_CAP: "DAILY_CAP",
  INVALID_TIMEZONE: "INVALID_TIMEZONE",
};

// ---------- time helpers ----------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function partsOf(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

const dayKey = (ms, tz) => { const p = partsOf(ms, tz); return p.y * 10000 + p.m * 100 + p.d; };

// Wall-clock time in tz -> UTC ms. Converges in a few steps; in a DST gap it lands next to the gap.
function localToUtc(y, m, d, h, mi, tz) {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsOf(guess, tz);
    const diff = target - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return (+m[1] % 24) * 60 + +m[2];
}

function compileQuiet(q) {
  if (!q) return null;
  const start = parseHHMM(q.start), end = parseHHMM(q.end);
  if (start === end) return null; // empty window
  return { start, end, startText: q.start, endText: q.end };
}

function inQuiet(q, ms, tz) {
  if (!q) return false;
  const p = partsOf(ms, tz);
  const min = p.h * 60 + p.mi;
  return q.start < q.end ? min >= q.start && min < q.end : min >= q.start || min < q.end;
}

// Next moment the quiet window closes, strictly after ms (ms is inside the window).
function quietOpensAt(q, ms, tz) {
  const p = partsOf(ms, tz);
  const eh = Math.floor(q.end / 60), em = q.end % 60;
  let t = localToUtc(p.y, p.m, p.d, eh, em, tz);
  if (t <= ms) {
    const n = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    t = localToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), eh, em, tz);
  }
  return t;
}

function nextDayStart(ms, tz) {
  const p = partsOf(ms, tz);
  const n = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return localToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz);
}

// ---------- policy evaluation (shared by decide, dryRun and the explanations) ----------

function normalizePolicy(policy) {
  const cap = policy.dailyCap;
  if (cap != null && !(typeof cap === "number" && cap >= 0)) throw new Error("dailyCap must be a non-negative number or null");
  return { quiet: compileQuiet(policy.quietHours), cap: cap ?? null };
}

function countOnDay(deliveredMs, ms, tz) {
  const k = dayKey(ms, tz);
  let n = 0;
  for (const t of deliveredMs) if (dayKey(t, tz) === k) n++;
  return n;
}

function evaluate({ consent, tz, ms, deliveredMs, policy }) {
  if (consent !== true) return RULES.NO_CONSENT;
  try { formatter(tz); } catch { return RULES.INVALID_TIMEZONE; }
  if (inQuiet(policy.quiet, ms, tz)) return RULES.QUIET_HOURS;
  if (policy.cap !== null && countOnDay(deliveredMs, ms, tz) >= policy.cap) return RULES.DAILY_CAP;
  return null;
}

// Earliest instant at or after ms where both time rules pass, given deliveries already counted.
function earliestAllowed(ms, tz, deliveredMs, policy) {
  let t = ms;
  for (let i = 0; i < 20; i++) {
    if (inQuiet(policy.quiet, t, tz)) { t = quietOpensAt(policy.quiet, t, tz); continue; }
    if (policy.cap !== null && countOnDay(deliveredMs, t, tz) >= policy.cap) {
      if (policy.cap === 0) return null;
      t = nextDayStart(t, tz);
      continue;
    }
    return t;
  }
  return null;
}

function fmtLocal(ms, tz) {
  const p = partsOf(ms, tz);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.m)}-${z(p.d)} ${z(p.h)}:${z(p.mi)} (${tz})`;
}

function explain({ ruleCode, tz, ms, availableMs, policy }) {
  switch (ruleCode) {
    case null:
      return `This notification was delivered on ${fmtLocal(ms, tz)}.`;
    case RULES.NO_CONSENT:
      return "We did not send this notification because you have not given consent to receive notifications.";
    case RULES.INVALID_TIMEZONE:
      return "We did not send this notification because the time zone on your account is not valid, so we could not tell whether it was a good time to reach you.";
    case RULES.QUIET_HOURS:
      return `We did not send this notification because it came during quiet hours (${policy.quiet.startText} to ${policy.quiet.endText} your local time)`
        + (availableMs != null ? `; the earliest it could have been delivered was ${fmtLocal(availableMs, tz)}.` : ".");
    case RULES.DAILY_CAP:
      return `We did not send this notification because you had already received the daily maximum of ${policy.cap} notifications for that local day`
        + (availableMs != null ? `; the earliest it could have been delivered was ${fmtLocal(availableMs, tz)}.` : ".");
    default:
      return "This notification was not delivered.";
  }
}

// ---------- persistent state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR environment variable is not set");
  return dir;
}

function userFile(dir, userId) {
  const h = crypto.createHash("sha256").update(String(userId)).digest("hex");
  return path.join(dir, `user-${h}.jsonl`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { // break a lock left behind by a crashed process
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 10000) { await fs.rmdir(lock).catch(() => {}); continue; }
      } catch { continue; }
      if (Date.now() - started > 30000) throw new Error("Timed out waiting for state lock");
      await sleep(Math.min(5 + attempt * 2, 40) + Math.random() * 10);
    }
  }
  try { return await fn(); } finally { await fs.rmdir(lock).catch(() => {}); }
}

async function readLog(file) {
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line from a crash: ignore */ }
  }
  return out;
}

async function appendRecord(file, rec) {
  const fh = await fs.open(file, "a");
  try { await fh.write(JSON.stringify(rec) + "\n"); await fh.datasync(); } finally { await fh.close(); }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  const ms = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(ms)) throw new Error("now must be a valid Date");
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const file = userFile(dir, user.id);
  const policy = normalizePolicy(DEFAULT_POLICY);

  return withLock(file, async () => {
    const log = await readLog(file);
    // A retry of a notification that was already delivered must not deliver or count twice.
    if (log.some((r) => r.notificationId === notification.id && r.delivered)) return { send: false };

    const deliveredMs = log.filter((r) => r.delivered).map((r) => Date.parse(r.at));
    const tz = user.timezone;
    const ruleCode = evaluate({ consent: user.consent, tz, ms, deliveredMs, policy });
    let availableMs = null;
    if (ruleCode === RULES.QUIET_HOURS || ruleCode === RULES.DAILY_CAP) availableMs = earliestAllowed(ms, tz, deliveredMs, policy);
    if (ruleCode === null) availableMs = ms;
    const rec = {
      notificationId: notification.id,
      at: new Date(ms).toISOString(),
      delivered: ruleCode === null,
      ruleCode,
      availableAt: availableMs == null ? null : new Date(availableMs).toISOString(),
      text: explain({ ruleCode, tz, ms, availableMs, policy }),
    };
    await appendRecord(file, rec);
    return { send: rec.delivered };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const f = Date.parse(from), t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) throw new Error("from and to must be ISO 8601 strings");
  const dir = stateDir();
  const file = userFile(dir, userId);
  const log = await withLock(file, () => readLog(file)).catch(async (e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  return log
    .filter((r) => { const a = Date.parse(r.at); return a >= f && a < t; })
    .map(({ notificationId, at, delivered, ruleCode, availableAt, text }) => ({ notificationId, at, delivered, ruleCode, availableAt, text }));
}

// Pure replay: reads nothing from STATE_DIR and writes nothing anywhere.
export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy ?? DEFAULT_POLICY);
  const ordered = events
    .map((e, i) => ({ e, i, ms: Date.parse(e.at) }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const deliveredByUser = new Map();
  let delivered = 0, blocked = 0;
  for (const { e, ms } of ordered) {
    const list = deliveredByUser.get(e.user.id) ?? [];
    const ruleCode = Number.isNaN(ms) ? RULES.INVALID_TIMEZONE
      : evaluate({ consent: e.user.consent, tz: e.user.timezone, ms, deliveredMs: list, policy: pol });
    if (ruleCode === null) { delivered++; list.push(ms); deliveredByUser.set(e.user.id, list); } else blocked++;
  }
  return { delivered, blocked };
}
