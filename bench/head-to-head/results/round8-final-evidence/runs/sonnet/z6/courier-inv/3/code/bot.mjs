import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

// Current production policy: 3 per local calendar day, quiet 22:00-08:00 local, consent required.
const CURRENT_POLICY = { quietHours: { start: "22:00", end: "08:00" }, dailyCap: 3 };

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
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function parts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, min: o.minute, s: o.second };
}

const dayKey = (p) => `${p.y}-${p.m}-${p.d}`;
const pad = (n) => String(n).padStart(2, "0");

function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

// Instant at which the wall clock in tz reads y-m-d h:min.
function localToInstant(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

// First instant strictly after afterMs at which the local clock reads minuteOfDay.
function nextLocalTime(afterMs, tz, minuteOfDay) {
  const p = parts(afterMs, tz);
  for (let add = 0; add <= 2; add++) {
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
    const t = localToInstant(
      dt.getUTCFullYear(),
      dt.getUTCMonth() + 1,
      dt.getUTCDate(),
      Math.floor(minuteOfDay / 60),
      minuteOfDay % 60,
      tz,
    );
    if (t > afterMs) return t;
  }
  return null;
}

function startOfNextLocalDay(ms, tz) {
  const p = parts(ms, tz);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return localToInstant(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0, 0, tz);
}

function localLabel(ms, tz) {
  const p = parts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`;
}

// ---------- policy ----------

function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof v === "string" ? v : "");
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new TypeError(`Invalid time "${v}", expected HH:MM`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("policy is required");
  let quiet = null;
  if (policy.quietHours != null) {
    quiet = { start: parseHHMM(policy.quietHours.start), end: parseHHMM(policy.quietHours.end) };
  }
  let cap = null;
  if (policy.dailyCap != null) {
    if (typeof policy.dailyCap !== "number" || !(policy.dailyCap >= 0)) {
      throw new TypeError("dailyCap must be a non-negative number or null");
    }
    cap = policy.dailyCap;
  }
  return { quiet, cap };
}

function inQuiet(quiet, minuteOfDay) {
  if (!quiet || quiet.start === quiet.end) return false;
  if (quiet.start < quiet.end) return minuteOfDay >= quiet.start && minuteOfDay < quiet.end;
  return minuteOfDay >= quiet.start || minuteOfDay < quiet.end;
}

const minuteOfDay = (p) => p.h * 60 + p.min;

// Shared by decide() and dryRun(). Rule order: consent, quiet hours, daily cap.
// Returns { ruleCode, availableAtMs } where ruleCode is null when delivery is allowed.
function evaluate({ policy, consent, tz, atMs, deliveredToday }) {
  if (consent !== true) return { ruleCode: RULES.NO_CONSENT, availableAtMs: null };
  if (!isValidTimezone(tz)) return { ruleCode: RULES.INVALID_TIMEZONE, availableAtMs: null };
  const { quiet, cap } = policy;
  const p = parts(atMs, tz);
  if (inQuiet(quiet, minuteOfDay(p))) {
    return { ruleCode: RULES.QUIET_HOURS, availableAtMs: nextLocalTime(atMs, tz, quiet.end) };
  }
  if (cap != null && deliveredToday >= cap) {
    let t = startOfNextLocalDay(atMs, tz);
    if (quiet && inQuiet(quiet, minuteOfDay(parts(t, tz)))) t = nextLocalTime(t, tz, quiet.end);
    return { ruleCode: RULES.DAILY_CAP, availableAtMs: t };
  }
  return { ruleCode: null, availableAtMs: null };
}

// ---------- state (append-only per-user log, guarded by a lock file) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

function userPaths(userId) {
  const h = createHash("sha256").update(String(userId)).digest("hex");
  const dir = stateDir();
  return { dir: path.join(dir, "users"), log: path.join(dir, "users", `${h}.jsonl`), lock: path.join(dir, "users", `${h}.lock`) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STALE_LOCK_MS = 10_000;

async function withLock(lockPath, fn) {
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (Date.now() - started > 60_000) throw new Error("timed out waiting for state lock");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function readLog(logPath) {
  let raw;
  try {
    raw = await readFile(logPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn or partial line from a crash; ignore
    }
  }
  return out;
}

async function appendRecord(logPath, record) {
  const fh = await open(logPath, "a");
  try {
    await fh.write(JSON.stringify(record) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ---------- public API ----------

function toMs(at, label) {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(ms)) throw new TypeError(`Invalid ${label}`);
  return ms;
}

export async function decide({ user, notification, now }) {
  const atMs = toMs(now, "now");
  const paths = userPaths(user.id);
  await mkdir(paths.dir, { recursive: true });
  const policy = normalizePolicy(CURRENT_POLICY);

  return withLock(paths.lock, async () => {
    const records = await readLog(paths.log);

    // Replay of a notification already delivered: allow again, do not count twice.
    if (records.some((r) => r.notificationId === notification.id && r.delivered)) {
      return { send: true };
    }

    const tz = user.timezone;
    let deliveredToday = 0;
    if (isValidTimezone(tz)) {
      const today = dayKey(parts(atMs, tz));
      for (const r of records) {
        if (r.delivered && dayKey(parts(r.atMs, tz)) === today) deliveredToday++;
      }
    }

    const { ruleCode, availableAtMs } = evaluate({
      policy,
      consent: user.consent,
      tz,
      atMs,
      deliveredToday,
    });
    const delivered = ruleCode === null;
    await appendRecord(paths.log, {
      userId: user.id,
      notificationId: notification.id,
      atMs,
      tz: isValidTimezone(tz) ? tz : null,
      delivered,
      ruleCode,
      availableAtMs,
    });
    return { send: delivered };
  });
}

function explain(r) {
  const when = r.tz ? ` (${r.tz} time)` : "";
  const avail = r.availableAtMs != null && r.tz ? localLabel(r.availableAtMs, r.tz) : null;
  switch (r.ruleCode) {
    case null:
      return r.tz
        ? `This notification was delivered at ${localLabel(r.atMs, r.tz)}${when}.`
        : "This notification was delivered.";
    case RULES.NO_CONSENT:
      return "This notification was not sent because you have not given consent to receive notifications, and it cannot be delivered unless you opt in.";
    case RULES.QUIET_HOURS:
      return `This notification was not sent because it arrived during quiet hours (22:00 to 08:00 in your local time)${avail ? `; it could have been delivered from ${avail}${when}` : ""}.`;
    case RULES.DAILY_CAP:
      return `This notification was not sent because you had already received the limit of 3 notifications for that calendar day in your local time${avail ? `; it could have been delivered from ${avail}${when}` : ""}.`;
    case RULES.INVALID_TIMEZONE:
      return "This notification was not sent because we do not have a valid time zone on file for your account.";
    default:
      return `This notification was not sent (rule ${r.ruleCode}).`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = toMs(from, "from");
  const toMsV = toMs(to, "to");
  const { log } = userPaths(userId);
  const records = await readLog(log);
  return records
    .filter((r) => r.atMs >= fromMs && r.atMs < toMsV)
    .map((r) => ({
      notificationId: r.notificationId,
      at: new Date(r.atMs).toISOString(),
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAtMs != null ? new Date(r.availableAtMs).toISOString() : null,
      text: explain(r),
    }));
}

// Pure simulation: touches no state.
export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  const items = events.map((e, i) => ({ e, i, atMs: toMs(e.at, "event.at") }));
  items.sort((a, b) => a.atMs - b.atMs || a.i - b.i);

  const perUser = new Map(); // userId -> { deliveredAt: number[], deliveredIds: Set }
  let delivered = 0;
  let blocked = 0;
  for (const { e, atMs } of items) {
    let s = perUser.get(e.user.id);
    if (!s) perUser.set(e.user.id, (s = { deliveredAt: [], ids: new Set() }));
    if (s.ids.has(e.notification.id)) {
      delivered++; // replay of an already delivered notification, as in decide()
      continue;
    }
    const tz = e.user.timezone;
    let deliveredToday = 0;
    if (isValidTimezone(tz)) {
      const today = dayKey(parts(atMs, tz));
      for (const t of s.deliveredAt) if (dayKey(parts(t, tz)) === today) deliveredToday++;
    }
    const { ruleCode } = evaluate({ policy: pol, consent: e.user.consent, tz, atMs, deliveredToday });
    if (ruleCode === null) {
      delivered++;
      s.deliveredAt.push(atMs);
      s.ids.add(e.notification.id);
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
