// Push gate: decides whether the agent may send a push to a user right now.
// History is kept in memory only. A restart clears it, which is accepted.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Minimum spacing between two pushes to the same user. Apple's and Google's
// notification guidance both warn against bursts; several nudges within an
// hour feel like spam even when each one is useful on its own.
const MIN_GAP_MS = 60 * MINUTE;

// History older than this can never affect a decision: "today" in any IANA
// zone started less than 26 hours before "now", and the gap check only looks
// back MIN_GAP_MS. Two days leaves a safe margin.
const KEEP_MS = 2 * DAY;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone, which is the behaviour we want.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Wall-clock view of an instant in the user's zone. The calendar date is what
// "per day" means to the user; the minute of day is what "night" means.
function localView(epochMs, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(epochMs)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseClock(value, field) {
  const match = typeof value === 'string' && HHMM.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be an HH:MM string, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Returns null when the user has no quiet period configured.
function quietWindow(user) {
  const hasStart = user.quietStart != null;
  const hasEnd = user.quietEnd != null;
  if (!hasStart && !hasEnd) return null;
  if (!hasStart || !hasEnd) {
    throw new TypeError('quietStart and quietEnd must be set together');
  }
  const start = parseClock(user.quietStart, 'quietStart');
  const end = parseClock(user.quietEnd, 'quietEnd');
  if (start === end) return null; // empty window: no quiet period
  return { start, end };
}

// The window may wrap past midnight, e.g. 22:00 to 07:00.
function inQuietWindow(minuteOfDay, { start, end }) {
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

export function createPushGate() {
  // userId -> epoch ms of each push that was allowed, pruned to KEEP_MS.
  const sentByUser = new Map();

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid Date');
    }
    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
      throw new TypeError('dailyCap must be a non-negative integer');
    }

    const nowMs = now.getTime();
    const zone = user.timeZone;
    const today = localView(nowMs, zone);

    // 1. Quiet hours: never wake the user at night, by their own clock.
    const quiet = quietWindow(user);
    if (quiet && inQuietWindow(today.minuteOfDay, quiet)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    const history = (sentByUser.get(user.id) ?? []).filter(
      (ms) => nowMs - ms < KEEP_MS,
    );
    sentByUser.set(user.id, history);

    // 2. Daily cap: pushes already sent on the same calendar day in the user's zone.
    const sentToday = history.filter(
      (ms) => localView(ms, zone).date === today.date,
    ).length;
    if (sentToday >= user.dailyCap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    // 3. Spacing: not too soon after the most recent push.
    if (history.length > 0) {
      const lastMs = Math.max(...history);
      if (nowMs - lastMs < MIN_GAP_MS) {
        return { allowed: false, reason: 'too_soon_after_last_push' };
      }
    }

    history.push(nowMs);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
