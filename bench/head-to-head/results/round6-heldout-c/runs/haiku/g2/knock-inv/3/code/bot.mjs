// Push send gate. Called right before a push is handed to the provider.
// State is in memory only; a restart forgets all counts.

const MARKETING_DAILY_CAP = 3;
const CATEGORIES = new Set(['marketing', 'transactional']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> { day: 'YYYY-MM-DD' (customer-local), count: number }
const marketingSentByUser = new Map();
const formatters = new Map();

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    // Throws a RangeError for an unknown IANA time zone name.
    formatter = new Intl.DateTimeFormat('en-CA', {
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

// Customer-local calendar day and minute-of-day for the instant `now`.
function localClock(now, timezone) {
  const parts = {};
  for (const part of formatterFor(timezone).formatToParts(now)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, name) {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when `minute` falls in [start, end). A window may wrap past midnight.
// start === end means no quiet window.
function inQuietWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function validate(candidate, now) {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('candidate must be an object');
  }
  if (typeof candidate.userId !== 'string' || candidate.userId === '') {
    throw new TypeError('candidate.userId must be a non-empty string');
  }
  if (!CATEGORIES.has(candidate.category)) {
    throw new TypeError(`candidate.category must be "marketing" or "transactional", got ${JSON.stringify(candidate.category)}`);
  }
  if (typeof candidate.timezone !== 'string') {
    throw new TypeError('candidate.timezone must be an IANA time zone name');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

export function decide(candidate, now) {
  validate(candidate, now);
  const { userId, category, timezone } = candidate;
  const quietStart = parseHHMM(candidate.quietStart, 'candidate.quietStart');
  const quietEnd = parseHHMM(candidate.quietEnd, 'candidate.quietEnd');

  // Transactional pushes (courier arriving, security code) are never blocked here.
  if (category === 'transactional') {
    return { send: true, rule: null };
  }

  const local = localClock(now, timezone);

  if (inQuietWindow(local.minute, quietStart, quietEnd)) {
    return { send: false, rule: 'quiet-hours' };
  }

  const record = marketingSentByUser.get(userId);
  const sentToday = record && record.day === local.day ? record.count : 0;
  if (sentToday >= MARKETING_DAILY_CAP) {
    return { send: false, rule: 'daily-cap' };
  }

  marketingSentByUser.set(userId, { day: local.day, count: sentToday + 1 });
  return { send: true, rule: null };
}
