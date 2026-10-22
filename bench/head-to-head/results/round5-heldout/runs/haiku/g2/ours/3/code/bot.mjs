// Push gate for agent-initiated nudges.
// Decides whether a push may be sent now. Never sends anything.
// State is in memory per gate instance; it does not survive a restart.

const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Formatters are pure per zone, so cache them.
const formatterCache = new Map();

function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function isValidZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    formatterFor(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

// Local wall-clock parts of an instant in the user's zone.
// Returns { date: 'YYYY-MM-DD', minutes: 0..1439 }.
function localParts(ms, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(ms)) {
    parts[p.type] = p.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Start is inclusive, end is exclusive. If start is later than end, the
// window wraps past midnight (22:00-07:00). Equal start and end is an empty window.
function inQuietWindow(minutes, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

export function createPushGate() {
  // userId -> array of sent timestamps (ms). Zone is not stored: the day
  // is recomputed with the zone passed on each call.
  const sent = new Map();

  function attempt(user, now) {
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_time' };
    }
    if (!isValidZone(user.timeZone)) {
      return { allowed: false, reason: 'invalid_time_zone' };
    }
    if (
      typeof user.quietStart !== 'string' ||
      typeof user.quietEnd !== 'string' ||
      !HHMM.test(user.quietStart) ||
      !HHMM.test(user.quietEnd)
    ) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }
    if (
      typeof user.dailyCap !== 'number' ||
      !Number.isInteger(user.dailyCap) ||
      user.dailyCap < 0
    ) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    const nowMs = now.getTime();
    const local = localParts(nowMs, user.timeZone);

    // Night: the user's local clock is inside their quiet window.
    if (inQuietWindow(local.minutes, toMinutes(user.quietStart), toMinutes(user.quietEnd))) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    // Per day: pushes already sent on the same local calendar date in the
    // user's zone. Drop records older than two days to bound memory.
    const history = (sent.get(user.id) ?? []).filter((ts) => ts >= nowMs - 2 * DAY_MS);
    const sentToday = history.filter(
      (ts) => localParts(ts, user.timeZone).date === local.date,
    ).length;
    sent.set(user.id, history);

    if (sentToday >= user.dailyCap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push(nowMs);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
