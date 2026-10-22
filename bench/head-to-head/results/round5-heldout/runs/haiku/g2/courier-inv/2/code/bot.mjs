// In-process push gate for the proactive agent.
//
// Decides whether a push may go to a user right now. Two rules:
//   1. Quiet hours: no pushes during the user's local night. The window is read
//      in the user's IANA time zone and may cross midnight.
//   2. Daily cap: at most `dailyCap` pushes per user's local calendar day
//      (midnight-to-midnight in the user's zone, not a rolling 24 hours).
//
// History lives in memory only. It is lost on restart, which is acceptable here.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Keep history for slightly more than two days. The longest UTC offset is
// about 14 hours, so any entry older than that cannot share a local day with `now`.
const HISTORY_MS = 50 * 60 * 60 * 1000;

const partFormatters = new Map();

function formatterFor(timeZone) {
  let fmt = partFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partFormatters.set(timeZone, fmt);
  }
  return fmt;
}

// Local wall-clock time of `date` in `timeZone`.
// Returns the calendar day as "YYYY-MM-DD" and the minute of the day (0-1439).
function localClock(date, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, name) {
  const match = typeof value === "string" ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be a 24-hour "HH:MM" string, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when `minute` falls inside [start, end). A window that crosses midnight
// (start > end, e.g. 22:00-07:00) wraps. start === end means no quiet period.
function inQuietWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function validateUser(user) {
  if (!user || typeof user !== "object") {
    throw new TypeError("user must be an object");
  }
  if (user.id === undefined || user.id === null || user.id === "") {
    throw new TypeError("user.id is required");
  }
  if (typeof user.timeZone !== "string") {
    throw new TypeError("user.timeZone must be an IANA zone name");
  }
  // Throws RangeError for an unknown zone, which is the right outcome.
  formatterFor(user.timeZone);
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError(`user.dailyCap must be a non-negative integer, got ${JSON.stringify(user.dailyCap)}`);
  }
}

export function createPushGate() {
  // userId -> array of epoch-ms timestamps of pushes that were allowed.
  const sent = new Map();

  function attempt(user, now) {
    validateUser(user);
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError("now must be a valid Date");
    }

    const quietStart = parseHHMM(user.quietStart, "user.quietStart");
    const quietEnd = parseHHMM(user.quietEnd, "user.quietEnd");

    const nowMs = now.getTime();
    const clock = localClock(now, user.timeZone);

    // 1. Quiet hours, judged on the user's local clock.
    if (inQuietWindow(clock.minute, quietStart, quietEnd)) {
      return { allowed: false, reason: "quiet_hours" };
    }

    // 2. Daily cap, counted per user's local calendar day.
    const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < HISTORY_MS);
    const pushesToday = history.filter(
      (t) => localClock(new Date(t), user.timeZone).day === clock.day,
    ).length;
    sent.set(user.id, history);

    if (pushesToday >= user.dailyCap) {
      return { allowed: false, reason: "daily_cap_reached" };
    }

    history.push(nowMs);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
