// Push gate for the agent's unsolicited notifications.
// attempt() decides whether a push may go now. It never sends anything.
// State lives in memory, per gate instance. Nothing survives a restart.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// One formatter per IANA zone; Intl is slow to construct.
const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone; the caller turns that into a hold.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Returns the recipient's local calendar date (YYYY-MM-DD) and minute of day,
// or null when the zone is missing or invalid.
function localClock(timeZone, now) {
  if (typeof timeZone !== 'string') return null;
  let parts;
  try {
    parts = formatterFor(timeZone).formatToParts(now);
  } catch {
    return null;
  }
  const v = {};
  for (const p of parts) v[p.type] = p.value;
  return {
    date: `${v.year}-${v.month}-${v.day}`,
    minutes: Number(v.hour) * 60 + Number(v.minute),
  };
}

function parseTime(value) {
  const m = typeof value === 'string' && TIME_RE.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Start is inclusive, end is exclusive. A start later than end wraps past midnight.
// Equal start and end means an empty window.
function inWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  // key: `${userId}|${localDate}` -> number of pushes allowed that local day
  const counts = new Map();

  function attempt(user, now) {
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_now' };
    }

    const clock = localClock(user.timeZone, now);
    if (!clock) {
      return { allowed: false, reason: 'invalid_time_zone' };
    }

    const start = parseTime(user.quietStart);
    const end = parseTime(user.quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }
    if (inWindow(clock.minutes, start, end)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    const key = `${user.id}|${clock.date}`;
    const sent = counts.get(key) ?? 0;
    if (sent >= cap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    counts.set(key, sent + 1);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
