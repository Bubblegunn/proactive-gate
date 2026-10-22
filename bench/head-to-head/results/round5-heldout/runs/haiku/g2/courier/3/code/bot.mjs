// Push gate for the meal-planning agent.
//
// The agent calls attempt(user, now) right before it would send a push.
// A call that returns allowed: true counts as a push sent to that user.
//
// Rules, checked in this order:
//   1. quiet_hours        - `now` falls in the user's quiet period (local time).
//   2. daily_cap_reached  - the user already got dailyCap pushes today (local day).
//   3. too_soon           - the last push to this user was less than MIN_GAP_MS ago.
//
// "Day" and "night" are the user's calendar day and clock in user.timeZone,
// not the server's zone and not UTC. A user in Tokyo at 23:00 is in quiet
// hours even if the server is in UTC and it is 14:00 there.

const MIN_GAP_MS = 60 * 60 * 1000;
const HISTORY_MS = 48 * 60 * 60 * 1000; // covers any local calendar day

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      throw new TypeError(`invalid timeZone: ${timeZone}`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar day ("2026-10-22") and minute of day (0-1439) for an instant.
function localParts(date, timeZone) {
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
  const m = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!m) {
    throw new TypeError(`${name} must be HH:MM, got ${JSON.stringify(value)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// start === end means no quiet period. start > end means the period crosses midnight,
// e.g. 22:00-07:00 covers 22:00-23:59 and 00:00-06:59.
function inQuietHours(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function createPushGate() {
  // userId -> array of sent-push timestamps (ms), pruned to HISTORY_MS
  const sent = new Map();

  function attempt(user, now) {
    if (!user || typeof user !== 'object') {
      throw new TypeError('user must be an object');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid Date');
    }
    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
      throw new TypeError(`dailyCap must be a non-negative integer, got ${JSON.stringify(user.dailyCap)}`);
    }

    const start = parseHHMM(user.quietStart, 'quietStart');
    const end = parseHHMM(user.quietEnd, 'quietEnd');
    const local = localParts(now, user.timeZone);

    if (inQuietHours(local.minute, start, end)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    const history = sent.get(user.id) ?? [];
    const nowMs = now.getTime();
    const recent = history.filter((t) => Math.abs(nowMs - t) <= HISTORY_MS);

    const sentToday = recent.filter(
      (t) => localParts(new Date(t), user.timeZone).day === local.day,
    ).length;
    if (sentToday >= user.dailyCap) {
      sent.set(user.id, recent);
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    if (recent.some((t) => Math.abs(nowMs - t) < MIN_GAP_MS)) {
      sent.set(user.id, recent);
      return { allowed: false, reason: 'too_soon' };
    }

    recent.push(nowMs);
    sent.set(user.id, recent);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
