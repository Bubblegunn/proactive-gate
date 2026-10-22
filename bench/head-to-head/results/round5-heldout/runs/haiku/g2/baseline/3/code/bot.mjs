// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order:
//   1. quiet_hours        - the user's local time is inside their quiet period.
//   2. daily_cap_reached  - the user already received dailyCap pushes today.
//
// "Today" and "night" are the user's local calendar day and local clock time,
// both computed in user.timeZone (the device zone), never UTC or the server zone.
// History lives in memory only; it is lost on restart, which the caller accepts.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Keep this much history per user. A local calendar day is at most 26 hours long
// (zone offsets span -12h..+14h), so anything older than this can never count as "today".
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // hourCycle h23 avoids the "24:00" midnight quirk of hour12:false in some engines.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Local calendar date ("2026-10-22") and minutes since local midnight, in the given zone.
function localTime(date, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm, field) {
  const match = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null;
  if (!match) {
    throw new TypeError(`${field} must be a 24-hour HH:MM string, got ${JSON.stringify(hhmm)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Quiet period [start, end). If start > end it wraps past midnight (22:00-07:00).
// If start === end, or either bound is missing, there is no quiet period.
function isQuiet(minutes, quietStart, quietEnd) {
  if (quietStart == null || quietEnd == null) return false;
  const start = toMinutes(quietStart, 'quietStart');
  const end = toMinutes(quietEnd, 'quietEnd');
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function validate(user, now) {
  if (user == null || typeof user !== 'object') {
    throw new TypeError('user must be an object');
  }
  if (user.id == null) {
    throw new TypeError('user.id is required');
  }
  if (typeof user.timeZone !== 'string' || user.timeZone === '') {
    throw new TypeError('user.timeZone must be an IANA zone name');
  }
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError(`user.dailyCap must be a non-negative integer, got ${JSON.stringify(user.dailyCap)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

export function createPushGate() {
  // userId -> epoch ms of each push that was allowed.
  const sent = new Map();

  return {
    attempt(user, now) {
      validate(user, now);

      const { timeZone } = user;
      const today = localTime(now, timeZone);

      if (isQuiet(today.minutes, user.quietStart, user.quietEnd)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const cutoff = now.getTime() - HISTORY_WINDOW_MS;
      const history = (sent.get(user.id) ?? []).filter((ts) => ts > cutoff);

      // Count pushes that fell on the same local calendar day in the user's zone.
      const sentToday = history.filter(
        (ts) => localTime(new Date(ts), timeZone).day === today.day,
      ).length;

      if (sentToday >= user.dailyCap) {
        sent.set(user.id, history);
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      history.push(now.getTime());
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
