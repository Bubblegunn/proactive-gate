// Push gate: decides whether the agent may send one push to one user right now.
//
// "Day" means the user's calendar day in their own IANA time zone, not a rolling
// 24-hour window and not UTC. "Night" means the user's quiet window in their own
// zone, which may cross midnight.

const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Keep history for slightly more than one day. No time zone offset can make a
// timestamp older than 2 days fall on today's local date.
const HISTORY_MS = 2 * DAY_MS;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23', // avoids "24:00" at midnight on some engines
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      throw new TypeError(`invalid timeZone: ${timeZone}`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Returns the local calendar date ("YYYY-MM-DD") and minutes since local midnight.
function localParts(timeZone, date) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    parts[type] = value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(value, field) {
  const match = typeof value === 'string' && HHMM.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be HH:MM (24-hour), got: ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Quiet window [start, end). If start is after end, the window crosses midnight.
// start === end means no quiet window.
function isQuiet(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  // userId -> timestamps (ms) of pushes that were allowed
  const sent = new Map();

  function attempt(user, now) {
    if (!user || typeof user.id !== 'string') {
      throw new TypeError('user.id must be a string');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid Date');
    }
    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
      throw new TypeError('user.dailyCap must be a non-negative integer');
    }

    const { timeZone } = user;
    const today = localParts(timeZone, now);

    const quietStart = toMinutes(user.quietStart, 'quietStart');
    const quietEnd = toMinutes(user.quietEnd, 'quietEnd');
    if (isQuiet(today.minutes, quietStart, quietEnd)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    // Drop history that can no longer fall on today's local date, then count
    // what remains that falls on today's local date in the user's current zone.
    const cutoff = now.getTime() - HISTORY_MS;
    const history = (sent.get(user.id) ?? []).filter((t) => t > cutoff);
    const sentToday = history.filter(
      (t) => localParts(timeZone, new Date(t)).day === today.day,
    ).length;
    if (sentToday >= user.dailyCap) {
      sent.set(user.id, history);
      return { allowed: false, reason: 'daily_cap' };
    }

    history.push(now.getTime());
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
