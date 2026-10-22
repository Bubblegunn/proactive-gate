// Push gate: decides whether a candidate push may be sent right now.
// Call decide() right before handing a push to the provider.
// All state is in memory; a restart forgets the daily counts.

const MARKETING_DAILY_CAP = 3;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Marketing pushes allowed so far, per customer and customer-local day.
// Key: `${userId}|${YYYY-MM-DD}`, where the date is in the customer's time zone.
const sentCounts = new Map();

// Intl formatters are costly to build, so cache one per time zone.
const formatters = new Map();

// Day key of the last prune. Old keys are dropped once per UTC day.
let lastPruneDay = null;

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Returns the customer's local calendar date and minutes since local midnight.
function localParts(timeZone, instant) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function parseClock(value, name) {
  const match = typeof value === 'string' ? CLOCK_RE.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be "HH:MM" (24-hour), got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function assertTimeZone(timeZone) {
  try {
    formatterFor(timeZone);
  } catch {
    throw new TypeError(`timezone must be an IANA time zone name, got ${JSON.stringify(timeZone)}`);
  }
}

// Window is [start, end). If start > end it wraps past midnight.
// If start === end there is no quiet window.
function inQuietHours(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function dropOldDays(now) {
  const today = now.toISOString().slice(0, 10);
  if (today === lastPruneDay) return;
  lastPruneDay = today;
  // Customer-local dates are within about one day of the UTC date, so two days of margin is safe.
  const cutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of sentCounts.keys()) {
    if (key.slice(key.lastIndexOf('|') + 1) < cutoff) sentCounts.delete(key);
  }
}

// candidate: { userId, category: "marketing" | "transactional", timezone, quietStart, quietEnd }
// now: Date for the current instant.
// Returns { send, rule }. When send is true, the push is counted as sent.
export function decide(candidate, now) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('candidate must be an object');
  }
  const { userId, category, timezone } = candidate;
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (category !== 'marketing' && category !== 'transactional') {
    throw new TypeError(`category must be "marketing" or "transactional", got ${JSON.stringify(category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  assertTimeZone(timezone);
  const start = parseClock(candidate.quietStart, 'quietStart');
  const end = parseClock(candidate.quietEnd, 'quietEnd');

  // Transactional pushes (courier outside, security code) always go out.
  if (category === 'transactional') {
    return { send: true, rule: null };
  }

  const { date, minutes } = localParts(timezone, now);

  if (inQuietHours(minutes, start, end)) {
    return { send: false, rule: 'quiet-hours' };
  }

  const key = `${userId}|${date}`;
  const count = sentCounts.get(key) ?? 0;
  if (count >= MARKETING_DAILY_CAP) {
    return { send: false, rule: 'daily-cap' };
  }

  sentCounts.set(key, count + 1);
  dropOldDays(now);
  return { send: true, rule: null };
}
