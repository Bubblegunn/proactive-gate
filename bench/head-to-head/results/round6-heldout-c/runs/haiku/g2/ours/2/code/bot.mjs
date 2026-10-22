// Push gate: decides whether one push may go now. It never sends anything.
// State is in memory only; a restart forgets every count.

// Numbers chosen here:
const MARKETING_DAILY_CAP = 3; // marketing pushes per customer-local day

const CATEGORIES = new Set(['marketing', 'transactional']);
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> Map(localDay "YYYY-MM-DD" -> marketing pushes sent that day)
const sentCounts = new Map();

function hold(rule) {
  return { send: false, rule };
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Local calendar day and minute-of-day in the customer's zone.
function localParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// "HH:MM" -> minute of day, or null when malformed.
function toMinutes(hhmm) {
  const m = typeof hhmm === 'string' ? WINDOW_RE.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start is included, end is excluded. When start > end the window wraps past midnight.
function inWindow(minute, start, end) {
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

export function decide(candidate, now) {
  const { userId, category, timezone, quietStart, quietEnd } = candidate ?? {};

  if (typeof userId !== 'string' || userId === '') return hold('invalid-user');
  if (!CATEGORIES.has(category)) return hold('invalid-category');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');
  if (!isValidTimeZone(timezone)) return hold('invalid-timezone');

  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  // Equal start and end is ambiguous (empty or all day), so hold instead of guessing.
  if (start === null || end === null || start === end) return hold('invalid-quiet-window');

  const { day, minutes } = localParts(now, timezone);

  // Customer's own do-not-disturb window applies to every category.
  if (inWindow(minutes, start, end)) return hold('quiet-hours');

  if (category === 'marketing') {
    let days = sentCounts.get(userId);
    if (!days) {
      days = new Map();
      sentCounts.set(userId, days);
    }
    // Drop counts for days before the current local day.
    for (const d of days.keys()) {
      if (d < day) days.delete(d);
    }
    const count = days.get(day) ?? 0;
    if (count >= MARKETING_DAILY_CAP) return hold('daily-cap');
    days.set(day, count + 1);
  }

  // Transactional pushes skip the marketing cap and are not counted.
  return { send: true, rule: null };
}
