// Push gate: decides whether a push may go to the provider right now.
// State is in memory only; a restart forgets the daily counts.

const DAILY_MARKETING_CAP = 3;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> Map(localDate "YYYY-MM-DD" -> marketing pushes sent that day)
const marketingSent = new Map();
const formatters = new Map();

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone name.
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

// Local calendar date and minutes since local midnight, in the customer's zone.
function localParts(now, timezone) {
  const parts = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(now)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, field) {
  const match = typeof value === 'string' && HHMM.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be "HH:MM" (24-hour), got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Window may cross midnight (e.g. 22:00 -> 07:30). Equal start and end means no quiet time.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function validate(candidate, now) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('candidate must be an object');
  }
  if (typeof candidate.userId !== 'string' || candidate.userId === '') {
    throw new TypeError('candidate.userId must be a non-empty string');
  }
  if (candidate.category !== 'marketing' && candidate.category !== 'transactional') {
    throw new TypeError(`unknown category ${JSON.stringify(candidate.category)}`);
  }
  if (typeof candidate.timezone !== 'string') {
    throw new TypeError('candidate.timezone must be an IANA zone name');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

// Drops the user's counts for days before `date`, so memory stays bounded.
function recordMarketingSend(userId, date) {
  let byDate = marketingSent.get(userId);
  if (!byDate) {
    byDate = new Map();
    marketingSent.set(userId, byDate);
  }
  for (const day of byDate.keys()) {
    if (day < date) byDate.delete(day);
  }
  byDate.set(date, (byDate.get(date) ?? 0) + 1);
}

export function decide(candidate, now) {
  validate(candidate, now);
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  const local = localParts(now, timezone);

  // Transactional pushes (courier arriving, security code) are never capped or held back.
  if (category === 'transactional') {
    return { send: true, rule: null };
  }

  const start = parseHHMM(quietStart, 'candidate.quietStart');
  const end = parseHHMM(quietEnd, 'candidate.quietEnd');
  if (inQuietWindow(local.minutes, start, end)) {
    return { send: false, rule: 'quiet-hours' };
  }

  const sentToday = marketingSent.get(userId)?.get(local.date) ?? 0;
  if (sentToday >= DAILY_MARKETING_CAP) {
    return { send: false, rule: 'daily-cap' };
  }

  recordMarketingSend(userId, local.date);
  return { send: true, rule: null };
}
