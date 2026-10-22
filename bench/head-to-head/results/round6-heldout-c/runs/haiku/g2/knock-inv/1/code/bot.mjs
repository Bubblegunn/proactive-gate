// Push send gate. Called right before a push is handed to the provider.
// State is in memory only; a restart forgets all counts.
//
// Rule order (first failing rule is reported):
//   1. quiet-hours  marketing only; customer's own local DND window
//   2. daily-cap    marketing only; max 3 sent per customer-local calendar day
// Transactional pushes always pass. Only sent pushes are counted.

const DAILY_MARKETING_CAP = 3;
const CATEGORIES = new Set(['marketing', 'transactional']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> { day: 'YYYY-MM-DD' (customer-local), marketing: number, transactional: number }
const sentByUser = new Map();
// timezone -> Intl.DateTimeFormat
const formatters = new Map();

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new TypeError(`invalid IANA timezone: ${timezone}`);
    }
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// Returns the customer's local calendar day and minute-of-day for an instant.
function localClock(now, timezone) {
  const parts = {};
  for (const part of formatterFor(timezone).formatToParts(now)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(value, name) {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be "HH:MM" 24-hour time, got: ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Window [start, end). Wraps past midnight when start > end.
// start === end means no quiet window.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function validate(candidate, now) {
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('candidate must be an object');
  }
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CATEGORIES.has(category)) {
    throw new TypeError(`category must be "marketing" or "transactional", got: ${category}`);
  }
  if (typeof timezone !== 'string') {
    throw new TypeError('timezone must be an IANA time zone string');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return {
    userId,
    category,
    timezone,
    quietStart: toMinutes(quietStart, 'quietStart'),
    quietEnd: toMinutes(quietEnd, 'quietEnd'),
  };
}

export function decide(candidate, now) {
  const c = validate(candidate, now);
  const { day, minutes } = localClock(now, c.timezone);

  // Transactional pushes (e.g. courier nearby, security code) bypass quiet hours and the cap.
  if (c.category === 'marketing') {
    if (inQuietWindow(minutes, c.quietStart, c.quietEnd)) {
      return { send: false, rule: 'quiet-hours' };
    }
  }

  let counts = sentByUser.get(c.userId);
  if (!counts || counts.day !== day) {
    counts = { day, marketing: 0, transactional: 0 };
    sentByUser.set(c.userId, counts);
  }

  if (c.category === 'marketing' && counts.marketing >= DAILY_MARKETING_CAP) {
    return { send: false, rule: 'daily-cap' };
  }

  counts[c.category] += 1;
  return { send: true, rule: null };
}
