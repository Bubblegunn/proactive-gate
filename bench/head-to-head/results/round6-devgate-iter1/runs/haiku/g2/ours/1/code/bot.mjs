// Push gate for the meal-planning agent.
// attempt() decides whether one push may go now. It never sends anything.
// State is in memory: one process, nothing has to survive a restart.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// One Intl formatter per zone. Caching is safe because the zone is the key.
const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
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

// Wall-clock date (YYYY-MM-DD) and minute of day for `now` in the user's zone.
// Returns null when the zone is missing or unknown; the caller holds the push then.
function localParts(timeZone, now) {
  let parts;
  try {
    parts = formatterFor(timeZone).formatToParts(now);
  } catch {
    return null;
  }
  const get = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// "22:00" -> 1320. Returns null for anything that is not a 24-hour HH:MM string.
function parseHHMM(value) {
  const match = typeof value === 'string' && HHMM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Start is inclusive, end is exclusive. Equal start and end means no quiet period.
// When start is later than end, the window wraps past midnight.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

// The calendar day before a YYYY-MM-DD string, as a YYYY-MM-DD string.
function previousDay(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

export function createPushGate() {
  // userId -> Map(localDate -> pushes allowed so far that local day)
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
      }
      if (!user || user.id == null) {
        throw new TypeError('user.id is required');
      }

      // Recipient's local time. "Per day" and "night" are about the person, not the server.
      const local = localParts(user.timeZone, now);
      if (!local) return { allowed: false, reason: 'invalid_timezone' };

      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) {
        return { allowed: false, reason: 'invalid_quiet_hours' };
      }
      if (inQuietWindow(local.minutes, start, end)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) {
        return { allowed: false, reason: 'invalid_daily_cap' };
      }

      const days = sent.get(user.id) ?? new Map();
      // Drop counts older than yesterday so memory does not grow with uptime.
      const keepFrom = previousDay(local.date);
      for (const date of days.keys()) {
        if (date < keepFrom) days.delete(date);
      }

      const count = days.get(local.date) ?? 0;
      if (count >= cap) {
        sent.set(user.id, days);
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      days.set(local.date, count + 1);
      sent.set(user.id, days);
      return { allowed: true, reason: null };
    },
  };
}
