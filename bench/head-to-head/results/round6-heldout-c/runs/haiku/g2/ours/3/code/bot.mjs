// Push gate: decides whether a push may go out now. Never sends anything.
// State lives in memory only; a restart forgets the marketing counts.

const DAILY_MARKETING_CAP = 3;
const MARKETING = 'marketing';
const TRANSACTIONAL = 'transactional';

// userId -> Map(localDayKey "YYYY-MM-DD" -> marketing pushes sent that day)
const marketingSent = new Map();
const formatters = new Map();

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// Returns the customer's local day and minute-of-day, or null for an invalid zone.
function localTime(now, timezone) {
  let parts;
  try {
    parts = formatterFor(timezone).formatToParts(now);
  } catch {
    return null;
  }
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// "HH:MM" -> minutes since midnight, or null if malformed.
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Start minute included, end minute excluded. start > end wraps past midnight.
// start === end is an empty window.
function inWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function previousDayKey(dayKey) {
  const ms = Date.parse(`${dayKey}T00:00:00Z`) - 2 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function hold(rule) {
  return { send: false, rule };
}

export function decide(candidate, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('decide: now must be a valid Date');
  }
  if (!candidate || typeof candidate !== 'object') return hold('invalid-candidate');
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  if (typeof userId !== 'string' || userId === '') return hold('invalid-candidate');

  // Transactional pushes (courier arriving, security code) skip the marketing
  // cap and quiet hours. They are not counted toward the cap.
  if (category === TRANSACTIONAL) return { send: true, rule: null };
  if (category !== MARKETING) return hold('invalid-candidate');

  const local = typeof timezone === 'string' ? localTime(now, timezone) : null;
  if (!local) return hold('invalid-timezone');

  const start = parseClock(quietStart);
  const end = parseClock(quietEnd);
  if (start === null || end === null) return hold('invalid-quiet-window');
  if (inWindow(local.minuteOfDay, start, end)) return hold('quiet-hours');

  let days = marketingSent.get(userId);
  if (!days) {
    days = new Map();
    marketingSent.set(userId, days);
  }
  if ((days.get(local.dayKey) ?? 0) >= DAILY_MARKETING_CAP) return hold('daily-cap');

  days.set(local.dayKey, (days.get(local.dayKey) ?? 0) + 1);
  // Keep today, yesterday and the day before (small clock skew between callers).
  const oldest = previousDayKey(local.dayKey);
  for (const key of days.keys()) {
    if (key < oldest) days.delete(key);
  }
  return { send: true, rule: null };
}
