// Push gate: decides whether one push may go to the provider.
// Rules, checked in this order:
//   1. transactional pushes always send (no quiet-hours, no cap)
//   2. marketing pushes stop inside the customer's quiet window ("quiet-hours")
//   3. marketing pushes stop after 3 sends in the customer's local day ("daily-cap")
// State is in memory only; a restart forgets the daily counts.

const MARKETING_DAILY_CAP = 3;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> Map(localDateKey "YYYY-MM-DD" -> marketing sends counted that day)
const marketingSends = new Map();

const clockFormatters = new Map();

function clockFormatter(timezone) {
  let formatter = clockFormatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone, so bad input never reaches the send path.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    clockFormatters.set(timezone, formatter);
  }
  return formatter;
}

// Local calendar date and minute-of-day for `now` as seen in `timezone`.
function localClock(now, timezone) {
  const parts = {};
  for (const part of clockFormatter(timezone).formatToParts(now)) {
    parts[part.type] = part.value;
  }
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinuteOfDay(value, field) {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`candidate.${field} must be "HH:MM" (24-hour), got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// A window whose start equals its end is treated as empty (no quiet hours).
// A window with start > end runs past midnight.
function inQuietWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

// Returns the day-count map for a user, dropping counts for days before dateKey.
function marketingDays(userId, dateKey) {
  let days = marketingSends.get(userId);
  if (!days) {
    days = new Map();
    marketingSends.set(userId, days);
  }
  for (const key of days.keys()) {
    if (key < dateKey) days.delete(key);
  }
  return days;
}

const allow = () => ({ send: true, rule: null });
const block = (rule) => ({ send: false, rule });

export function decide(candidate, now) {
  const { userId, category, timezone, quietStart, quietEnd } = candidate;

  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('candidate.userId must be a non-empty string');
  }
  if (category !== 'marketing' && category !== 'transactional') {
    throw new TypeError(`candidate.category must be "marketing" or "transactional", got ${JSON.stringify(category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const start = toMinuteOfDay(quietStart, 'quietStart');
  const end = toMinuteOfDay(quietEnd, 'quietEnd');
  const { dateKey, minuteOfDay } = localClock(now, timezone);

  if (category === 'transactional') {
    return allow();
  }
  if (inQuietWindow(minuteOfDay, start, end)) {
    return block('quiet-hours');
  }

  // decide() is synchronous, so the check and the increment below cannot interleave with another call.
  const days = marketingDays(userId, dateKey);
  const sentToday = days.get(dateKey) ?? 0;
  if (sentToday >= MARKETING_DAILY_CAP) {
    return block('daily-cap');
  }
  days.set(dateKey, sentToday + 1);
  return allow();
}
