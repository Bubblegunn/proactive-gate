// Notification gate: 3 per local day, no sends 22:00-08:00 local, consent required.
// Decisions are stored per user under STATE_DIR so workers share them and restarts keep them.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DAILY_CAP = 3;
const QUIET_START = "22:00";
const QUIET_END = "08:00";

const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userDir(dir, userId) {
  const d = path.join(dir, "dec", sha(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function listRecords(udir) {
  const out = [];
  for (const f of fs.readdirSync(udir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(udir, f), "utf8")));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// Pure rule evaluation. `dayCount` is the number of deliveries already counted on the local day.
function evaluate({ ms, zone, consent, quiet, cap, dayCount }) {
  if (consent !== true) {
    return { send: false, ruleCode: "NO_CONSENT", availableAt: null,
      text: "We did not send this notification because the account has not given consent to receive notifications." };
  }
  if (!gkZoneOk(zone)) {
    return { send: false, ruleCode: "INVALID_TIMEZONE", availableAt: null,
      text: "We did not send this notification because the time zone on the account is missing or invalid, so we could not tell whether it was a suitable hour." };
  }
  if (quiet && gkInWindow(ms, zone, quiet.start, quiet.end)) {
    const next = gkNextOpen(ms, zone, quiet.end, quiet.start);
    return { send: false, ruleCode: "QUIET_HOURS", availableAt: next,
      text: `We did not send this notification because it arrived during quiet hours (${quiet.start} to ${quiet.end} local time); it could have been delivered from ${gkFmt(next, zone)}.` };
  }
  if (cap !== null && cap !== undefined && dayCount >= cap) {
    let next = gkNextMidnight(ms, zone);
    if (quiet && gkInWindow(next, zone, quiet.start, quiet.end)) next = gkNextOpen(next, zone, quiet.end, quiet.start);
    return { send: false, ruleCode: "DAILY_CAP", availableAt: next,
      text: `We did not send this notification because the daily limit of ${cap} notifications had already been reached for that day; it could have been delivered from ${gkFmt(next, zone)}.` };
  }
  return { send: true, ruleCode: null, availableAt: null, text: "This notification was delivered." };
}

export async function decide({ user, notification, now }) {
  const ms = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ms)) throw new Error("invalid now");
  const dir = stateDir();
  const udir = userDir(dir, user.id);
  const lock = gkAcquire(dir, "user:" + user.id); // one decision at a time per user, across processes
  try {
    const file = path.join(udir, sha(notification.id) + ".json");
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8"));
      return { send: prev.delivered }; // same id, same answer, nothing counted twice
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const records = listRecords(udir);
    const zone = user.timezone;
    const day = gkZoneOk(zone) ? gkDayKey(ms, zone) : null;
    const dayCount = day === null ? 0
      : records.filter((r) => r.delivered && r.dayKey === day).length;
    const r = evaluate({ ms, zone, consent: user.consent, quiet: { start: QUIET_START, end: QUIET_END }, cap: DAILY_CAP, dayCount });
    const rec = {
      seq: records.length ? records[records.length - 1].seq + 1 : 1,
      notificationId: notification.id, ms, delivered: r.send, dayKey: day,
      ruleCode: r.ruleCode, availableAt: r.availableAt, text: r.text,
    };
    writeAtomic(file, JSON.stringify(rec));
    return { send: r.send };
  } finally {
    gkRelease(lock);
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const f = new Date(from).getTime(), t = new Date(to).getTime();
  if (!Number.isFinite(f) || !Number.isFinite(t)) throw new Error("invalid from/to");
  const dir = stateDir();
  const udir = userDir(dir, userId);
  return listRecords(udir)
    .filter((r) => r.ms >= f && r.ms < t)
    .map((r) => ({
      notificationId: r.notificationId,
      at: new Date(r.ms).toISOString(),
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt === null ? null : new Date(r.availableAt).toISOString(),
      text: r.text,
    }));
}

// Replays events under a candidate policy in memory only; reads and writes no state.
export async function dryRun({ events, policy }) {
  const quiet = policy && policy.quietHours ? policy.quietHours : null;
  const cap = policy && policy.dailyCap !== undefined ? policy.dailyCap : null;
  const order = events.map((e, i) => ({ e, i, ms: new Date(e.at).getTime() }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const counts = new Map();
  const seen = new Map();
  let delivered = 0, blocked = 0;
  for (const { e, ms } of order) {
    const key = e.user.id + "\u0000" + e.notification.id;
    let send = seen.get(key);
    if (send === undefined) {
      const zone = e.user.timezone;
      const day = gkZoneOk(zone) ? gkDayKey(ms, zone) : null;
      const ck = e.user.id + "\u0000" + day;
      const r = evaluate({ ms, zone, consent: e.user.consent, quiet, cap, dayCount: counts.get(ck) || 0 });
      send = r.send;
      if (send) counts.set(ck, (counts.get(ck) || 0) + 1);
      seen.set(key, send);
    }
    if (send) delivered++; else blocked++;
  }
  return { delivered, blocked };
}

import * as gkFs from "node:fs";
import * as gkPath from "node:path";
import * as gkCrypto from "node:crypto";

// Returns true only for a non-empty string that Intl accepts as an IANA time zone.
function gkZoneOk(zone) {
  if (typeof zone !== "string" || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    return false;
  }
}

// Throws RangeError unless zone is a time zone gkZoneOk accepts (undefined and null are rejected, never the system zone).
function gkRequireZone(zone) {
  if (!gkZoneOk(zone)) throw new RangeError(`unknown time zone: ${String(zone)}`);
}

// Throws TypeError unless t is a finite number of epoch milliseconds (null, undefined, NaN and strings are rejected).
function gkRequireTime(t) {
  if (typeof t !== "number" || !Number.isFinite(t)) throw new TypeError(`epoch time must be a finite number, got ${String(t)}`);
}

// Throws TypeError unless key is a string.
function gkRequireKey(key) {
  if (typeof key !== "string") throw new TypeError(`key must be a string, got ${String(key)}`);
}

// Throws RangeError unless limit is a non-negative integer.
function gkRequireLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`limit must be a non-negative integer, got ${String(limit)}`);
}

// Returns the wall-clock fields of epoch ms t in the zone, read with a 24-hour clock.
function gkParts(t, zone) {
  gkRequireTime(t);
  gkRequireZone(zone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(t))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return { y: out.year, m: out.month, d: out.day, hh: out.hour, mm: out.minute, ss: out.second };
}

// Returns the zone's UTC offset in ms at epoch ms t, using whole seconds.
function gkOffset(t, zone) {
  const p = gkParts(t, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(t / 1000) * 1000;
}

// Formats year, month and day as a zero-padded YYYY-MM-DD string.
function gkYmd(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Returns the local date, time, weekday (0 = Sunday) and minutes past midnight of epoch ms t in the zone.
function gkLocal(t, zone) {
  const p = gkParts(t, zone);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return {
    y: p.y,
    m: p.m,
    d: p.d,
    hh: p.hh,
    mm: p.mm,
    ss: p.ss,
    dow,
    minutes: p.hh * 60 + p.mm,
    day: gkYmd(p.y, p.m, p.d),
  };
}

// Returns every epoch ms at which the zone's wall clock reads the given time (two in a fold, one normally, the first instant after the gap when nonexistent).
function gkCandidates(y, m, d, hh, mm, zone) {
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  const oBefore = gkOffset(wall - 86400000, zone);
  const oAfter = gkOffset(wall + 86400000, zone);
  const valid = [];
  for (const o of new Set([oBefore, oAfter])) {
    const t = wall - o;
    if (gkOffset(t, zone) === o) valid.push(t);
  }
  if (valid.length > 0) return valid;
  // Gap: binary search for the transition, the first instant whose offset is the later one.
  let lo = Math.min(wall - oBefore, wall - oAfter);
  let hi = Math.max(wall - oBefore, wall - oAfter);
  const target = gkOffset(hi, zone);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (gkOffset(mid, zone) === target) hi = mid;
    else lo = mid;
  }
  return [hi];
}

// Returns the earlier epoch ms at which the zone's wall clock reads the given time (the first instant after the gap when nonexistent).
function gkInstant(y, m, d, hh, mm, zone) {
  return Math.min(...gkCandidates(y, m, d, hh, mm, zone));
}

// Returns the instants in [from, to] at which the zone's UTC offset changes: a 15-minute scan, bisected to the millisecond.
function gkTransitions(from, to, zone) {
  const step = 15 * 60000;
  const found = [];
  let a = from;
  let offsetA = gkOffset(a, zone);
  while (a < to) {
    const b = Math.min(a + step, to);
    const offsetB = gkOffset(b, zone);
    if (offsetB !== offsetA) {
      let lo = a;
      let hi = b;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (gkOffset(mid, zone) === offsetA) lo = mid;
        else hi = mid;
      }
      found.push(hi);
    }
    a = b;
    offsetA = offsetB;
  }
  return found;
}

// Parses an "HH:MM" string into minutes past midnight; "24:00" is accepted only as an end; anything else throws RangeError.
function gkMinutesOf(text, isEnd) {
  if (typeof text === "string") {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    if (isEnd && text === "24:00") return 1440;
  }
  throw new RangeError(`expected HH:MM (00:00 to 23:59, or 24:00 as an end), got ${String(text)}`);
}

// Returns true when epoch ms t falls inside the local window start (inclusive) to end (exclusive), wrapping past midnight when start > end.
function gkInWindow(t, zone, start, end) {
  gkRequireZone(zone);
  gkRequireTime(t);
  const s = gkMinutesOf(start, false);
  const e = gkMinutesOf(end, true);
  if (s === e) return false;
  const m = gkLocal(t, zone).minutes;
  if (s < e) return m >= s && m < e;
  return m >= s || m < e;
}

// Returns the earliest instant at or after t inside the window, t itself when already inside, or null for an empty window.
// Candidates are the window's start instants on nearby days, plus every offset transition in the next 50 hours (a fall-back fold can re-enter a window without any start).
function gkNextOpen(t, zone, start, end) {
  gkRequireZone(zone);
  gkRequireTime(t);
  const startMin = gkMinutesOf(start, false);
  if (startMin === gkMinutesOf(end, true)) return null;
  if (gkInWindow(t, zone, start, end)) return t;
  const sh = Math.floor(startMin / 60);
  const sm = startMin % 60;
  const today = gkLocal(t, zone);
  const cands = gkTransitions(t, t + 50 * 3600000, zone);
  for (let k = -1; k <= 3; k += 1) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + k));
    cands.push(...gkCandidates(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sh, sm, zone));
  }
  let best = null;
  for (const cand of cands) {
    if (cand >= t && gkInWindow(cand, zone, start, end) && (best === null || cand < best)) best = cand;
  }
  return best;
}

// Returns the local day key YYYY-MM-DD of epoch ms t in the zone.
function gkDayKey(t, zone) {
  return gkLocal(t, zone).day;
}

// Returns the ISO week key YYYY-Www (Monday start, ISO year rules) of the local date at t.
function gkWeekKey(t, zone) {
  const p = gkLocal(t, zone);
  const date = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const isoDow = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - isoDow) * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - jan1) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// Returns the local month key YYYY-MM of epoch ms t in the zone.
function gkMonthKey(t, zone) {
  const p = gkLocal(t, zone);
  return gkYmd(p.y, p.m, 1).slice(0, 7);
}

// Returns the epoch ms of the start of the local day after the one containing t.
function gkNextMidnight(t, zone) {
  const cur = gkLocal(t, zone);
  const next = new Date(Date.UTC(cur.y, cur.m - 1, cur.d + 1));
  return gkInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, zone);
}

// Returns recipient-facing text such as "08:00 on 14 Mar (America/New_York)" with no ISO date or UTC/GMT label.
function gkFmt(t, zone) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = gkLocal(t, zone);
  const hh = String(p.hh).padStart(2, "0");
  const mm = String(p.mm).padStart(2, "0");
  return `${hh}:${mm} on ${p.d} ${names[p.m - 1]} (${zone})`;
}

// Lower-cases text, collapses whitespace, and strips punctuation and symbols from both edges (inner hyphens and spaces kept).
function gkNormalize(text) {
  if (typeof text !== "string") return "";
  let s = text.toLowerCase().replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^[^\p{L}\p{N}\- ]+/u, "").replace(/[^\p{L}\p{N}\- ]+$/u, "").trim();
  } while (s !== prev);
  return s;
}

// Returns true when the whole normalized message is a stop keyword.
function gkIsStop(text) {
  const words = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "opt-out", "optout"]);
  return words.has(gkNormalize(text));
}

// Returns true when the whole normalized message is start or unstop.
function gkIsStart(text) {
  const normalized = gkNormalize(text);
  return normalized === "start" || normalized === "unstop";
}

// Returns true when the whole normalized message is help or info.
function gkIsHelp(text) {
  const normalized = gkNormalize(text);
  return normalized === "help" || normalized === "info";
}

// Returns the path of the state file for key with the given suffix; creates nothing.
function gkPathFor(dir, key, suffix) {
  gkRequireKey(key);
  const hash = gkCrypto.createHash("sha1").update(key).digest("hex");
  return gkPath.join(dir, hash + suffix);
}

// Writes text to a file atomically: a temp file in the same directory, then rename.
function gkWriteText(file, text) {
  gkFs.mkdirSync(gkPath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${gkCrypto.randomBytes(6).toString("hex")}.tmp`;
  gkFs.writeFileSync(tmp, text);
  gkFs.renameSync(tmp, file);
}

// Returns the object stored under key in dir, or null when there is none; never creates dir.
function gkRead(dir, key) {
  try {
    return JSON.parse(gkFs.readFileSync(gkPathFor(dir, key, ".json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Stores obj under key in dir, atomically replacing any previous value.
function gkWrite(dir, key, obj) {
  gkWriteText(gkPathFor(dir, key, ".json"), JSON.stringify(obj));
  return true;
}

// Takes the exclusive claim for key; returns true for exactly one caller ever, false for everyone else.
function gkClaim(dir, key) {
  gkFs.mkdirSync(dir, { recursive: true });
  try {
    gkFs.writeFileSync(gkPathFor(dir, key, ".claim"), "", { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// Removes the claim for key; returns true only when a claim existed.
function gkUnclaim(dir, key) {
  try {
    gkFs.unlinkSync(gkPathFor(dir, key, ".claim"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Removes the lock at lock only when it is older than 10 seconds. It is renamed to a unique name first, so only the process whose rename succeeds deletes it.
function gkBreakIfStale(dir, lock) {
  let age;
  try {
    age = Date.now() - gkFs.statSync(lock).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (age <= 10000) return;
  const moved = gkPath.join(dir, `${gkPath.basename(lock)}.broken-${process.pid}-${gkCrypto.randomBytes(6).toString("hex")}`);
  try {
    gkFs.renameSync(lock, moved);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (Date.now() - gkFs.statSync(moved).mtimeMs <= 10000) {
    // A fresh lock replaced the stale one between stat and rename: put it back if the path is free.
    try {
      gkFs.renameSync(moved, lock);
      return;
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
  }
  gkFs.rmSync(moved, { recursive: true, force: true });
}

// Takes the lock directory for key, pausing 2 ms between tries and breaking stale locks; returns the lock path.
function gkAcquire(dir, key) {
  gkFs.mkdirSync(dir, { recursive: true });
  const lock = gkPathFor(dir, key, ".lock");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      gkFs.mkdirSync(lock);
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      gkBreakIfStale(dir, lock);
      Atomics.wait(pause, 0, 0, 2);
    }
  }
}

// Releases a lock directory taken by gkAcquire; a lock that is already gone is not an error.
function gkRelease(lock) {
  try {
    gkFs.rmdirSync(lock);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Reads the stored counter for key, 0 when none; the caller must hold the lock.
function gkReadCount(dir, key) {
  try {
    return JSON.parse(gkFs.readFileSync(gkPathFor(dir, key, ".count"), "utf8")).n;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

// Stores the counter value n for key atomically; the caller must hold the lock.
function gkStoreCount(dir, key, n) {
  gkWriteText(gkPathFor(dir, key, ".count"), JSON.stringify({ n }));
}

// Increments the counter for key only while it is below limit; returns {ok, n}. Serialised across processes by a lock directory.
function gkCount(dir, key, limit) {
  gkRequireLimit(limit);
  const lock = gkAcquire(dir, key);
  try {
    const n = gkReadCount(dir, key);
    if (n < limit) {
      gkStoreCount(dir, key, n + 1);
      return { ok: true, n: n + 1 };
    }
    return { ok: false, n };
  } finally {
    gkRelease(lock);
  }
}

// Decrements the counter for key, not below zero, and returns the new count. Serialised like gkCount.
function gkRefund(dir, key) {
  const lock = gkAcquire(dir, key);
  try {
    const n = Math.max(0, gkReadCount(dir, key) - 1);
    gkStoreCount(dir, key, n);
    return n;
  } finally {
    gkRelease(lock);
  }
}
