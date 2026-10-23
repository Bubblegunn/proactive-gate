// Morning briefing delivery gate (push + in-app).
//
// Policy, in order:
//   1. The user switched the category off (categories[type] === false): nothing is delivered.
//   2. The user snoozed (snoozedUntil in the future): nothing is delivered, resumeAt is the first
//      allowed moment after the snooze ends.
//   3. The briefing only goes out in the wake window (07:00-11:00 user-local). Outside it nothing
//      is delivered and resumeAt is the next 07:00 local. Other card types never push during quiet
//      hours (22:00-07:00 local), but their in-app item is still stored.
//   4. Push additionally needs: category explicitly on, OS permission not off, explicit
//      consents.push === true, no dismissal back-off, at most one push per type per local day, and
//      the candidate not pushed before. A failed push never blocks the in-app item.
// State (dismissals, what was delivered) lives in STATE_DIR, one JSON file per user, guarded by a
// per-user lock directory so parallel workers cannot double-send.

import { mkdir, readFile, writeFile, rename, rmdir, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const WAKE_HOUR = 7;
const WINDOW_END_HOUR = 11;
const QUIET_START_HOUR = 22;
const DISMISS_LIMIT = 3;
const DISMISS_LOOKBACK_MS = 14 * 86400000;
const DISMISS_PAUSE_MS = 7 * 86400000;
const KEEP_MS = 40 * 86400000;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 15000;

// ---------- time helpers ----------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

function localParts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  return o;
}

function offsetMs(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h, 0);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

function localHour(ms, tz) {
  const p = localParts(ms, tz);
  return p.hour + p.minute / 60;
}

function localDay(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// First instant strictly after `ms` that is WAKE_HOUR local.
function nextWake(ms, tz) {
  const p = localParts(ms, tz);
  for (let k = 0; k <= 3; k++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + k));
    const t = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), WAKE_HOUR, tz);
    if (t > ms) return t;
  }
  return null;
}

function inWakeWindow(ms, tz) {
  const h = localHour(ms, tz);
  return h >= WAKE_HOUR && h < WINDOW_END_HOUR;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return NaN;
}

const iso = (ms) => (ms == null || Number.isNaN(ms) ? null : new Date(ms).toISOString());

// ---------- shared state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withUserLock(userId, fn) {
  const root = stateDir();
  await mkdir(root, { recursive: true });
  const key = createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
  const lockDir = path.join(root, `${key}.lock`);
  const file = path.join(root, `${key}.json`);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const s = await stat(lockDir);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch { continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("could not lock user state");
      await sleep(10 + Math.random() * 20);
    }
  }
  try {
    let state;
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
      state = {};
    }
    state.dismissals ??= {};
    state.delivered ??= {};
    state.pushDays ??= {};
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
    return result;
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}

function prune(state, nowMs) {
  for (const [type, list] of Object.entries(state.dismissals)) {
    state.dismissals[type] = list.filter((t) => nowMs - t < DISMISS_LOOKBACK_MS);
    if (!state.dismissals[type].length) delete state.dismissals[type];
  }
  for (const [id, rec] of Object.entries(state.delivered)) {
    if (nowMs - rec.at > KEEP_MS) delete state.delivered[id];
  }
  for (const type of Object.keys(state.pushDays)) {
    const days = Object.keys(state.pushDays[type]).sort().slice(-3);
    state.pushDays[type] = Object.fromEntries(days.map((d) => [d, state.pushDays[type][d]]));
  }
}

function dismissalPauseEnd(state, type, nowMs) {
  const list = (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISS_LOOKBACK_MS);
  if (list.length < DISMISS_LIMIT) return null;
  const end = Math.max(...list) + DISMISS_PAUSE_MS;
  return end > nowMs ? end : null;
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const nowMs = toMs(now ?? new Date());
  const at = Number.isNaN(nowMs) ? Date.now() : nowMs;
  await withUserLock(userId, async (state) => {
    (state.dismissals[type] ??= []).push(at);
    prune(state, at);
  });
}

const none = (reason, resumeAt = null) => ({ push: false, inApp: false, reason, resumeAt });

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now ?? new Date());
  if (Number.isNaN(nowMs)) return none("The current time is not valid, so nothing was sent.");
  if (!user?.id || !candidate?.id || !candidate?.type) {
    return none("The user or the candidate is incomplete, so nothing was sent.");
  }
  const type = candidate.type;
  const isBriefing = type === "briefing";
  const tz = user.timezone;
  const category = user.categories?.[type];

  if (category === false) {
    return none(`The user switched off ${type} notifications.`);
  }

  if (!validTimezone(tz)) {
    return none("The user's timezone is unknown, so the local wake time cannot be checked.");
  }

  if (user.snoozedUntil != null) {
    const until = Date.parse(user.snoozedUntil);
    if (Number.isNaN(until)) return none("The snooze setting is not readable, so nothing was sent.");
    if (until > nowMs) {
      const resume = isBriefing && !inWakeWindow(until, tz) ? nextWake(until, tz) : until;
      return none("The user snoozed notifications.", iso(resume));
    }
  }

  let quietNow = false;
  if (isBriefing) {
    if (!inWakeWindow(nowMs, tz)) {
      return none(
        "It is outside the morning window (07:00 to 11:00 in the user's time), so the briefing was held.",
        iso(nextWake(nowMs, tz)),
      );
    }
  } else {
    const h = localHour(nowMs, tz);
    quietNow = h >= QUIET_START_HOUR || h < WAKE_HOUR;
  }

  return withUserLock(user.id, async (state) => {
    prune(state, nowMs);
    const record = (state.delivered[candidate.id] ??= { push: false, inApp: false, at: nowMs });
    const day = localDay(nowMs, tz);

    // Decide whether push may go out.
    let pushReason = null;
    let pushResume = null;
    if (category !== true) {
      pushReason = "The user has not turned on push for this kind of notification.";
    } else if (user.notificationsPermitted === false) {
      pushReason = "Notifications are turned off for the app in the phone's settings.";
    } else if (record.push) {
      pushReason = "This notification was already pushed.";
    } else if (quietNow) {
      pushReason = "Quiet hours (22:00 to 07:00 in the user's time), so no push was sent.";
      pushResume = nextWake(nowMs, tz);
    } else {
      const pause = dismissalPauseEnd(state, type, nowMs);
      if (pause) {
        pushReason = "The user dismissed several of these recently, so push is paused.";
        pushResume = pause;
      } else if (state.pushDays[type]?.[day] && state.pushDays[type][day] !== candidate.id) {
        pushReason = "A push of this kind already went out today.";
        pushResume = nextWake(nowMs, tz);
      }
    }
    if (!pushReason) {
      try {
        const consents = await consentStore.get(user.id);
        if (consents?.push !== true) pushReason = "The user has not given consent for push.";
      } catch {
        pushReason = "Consent could not be checked right now, so push was withheld.";
      }
    }

    let push = false;
    let pushFailed = false;
    if (!pushReason) {
      try {
        push = (await transport.push(user, candidate)) === true;
      } catch {
        push = false;
      }
      if (push) {
        record.push = true;
        (state.pushDays[type] ??= {})[day] = candidate.id;
      } else {
        pushFailed = true;
      }
    }

    let inApp = false;
    let inAppFailed = false;
    if (record.inApp) {
      // Already stored by an earlier attempt: do not store a duplicate.
    } else {
      try {
        await transport.inApp(user, candidate);
        inApp = true;
        record.inApp = true;
      } catch {
        inAppFailed = true;
      }
    }

    let reason = null;
    if (pushFailed) {
      reason = "The phone did not accept the push (for example no device token).";
    } else if (pushReason) {
      reason = pushReason;
    }
    if (inAppFailed) {
      reason = (reason ? reason + " " : "") + "The in-app item could not be stored.";
    }
    const resumeAt = pushReason && !push ? iso(pushResume) : null;
    return { push, inApp, reason, resumeAt };
  });
}
