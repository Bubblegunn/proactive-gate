// Push-notification gate. Decides whether a push may go out right now.
// Does not send anything. State is in memory only; a restart forgets it.

const DAILY_MARKETING_CAP = 3;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Cache of Intl formatters, one per IANA time zone.
const formatters = new Map();

// userId -> { date: "YYYY-MM-DD" in the customer's zone, count: marketing pushes sent that day }
const marketingSent = new Map();

function formatterFor(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

// Returns the customer's local calendar date and minute-of-day for the instant `now`.
function localClock(timeZone, now) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, field) {
  const m = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!m) {
    throw new TypeError(`${field} must be a 24-hour "HH:MM" string, got ${JSON.stringify(value)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// Window [start, end). If start > end it wraps past midnight. start === end means no window.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function validate(candidate, now) {
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('candidate must be an object');
  }
  if (typeof candidate.userId !== 'string' || candidate.userId === '') {
    throw new TypeError('candidate.userId must be a non-empty string');
  }
  if (candidate.category !== 'marketing' && candidate.category !== 'transactional') {
    throw new TypeError(`candidate.category must be "marketing" or "transactional", got ${JSON.stringify(candidate.category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (typeof candidate.timezone !== 'string') {
    throw new TypeError('candidate.timezone must be an IANA time zone name');
  }
  try {
    formatterFor(candidate.timezone);
  } catch {
    throw new TypeError(`candidate.timezone is not a valid IANA time zone: ${JSON.stringify(candidate.timezone)}`);
  }
}

/**
 * @param {{userId: string, category: "marketing"|"transactional", timezone: string, quietStart: string, quietEnd: string}} candidate
 * @param {Date} now current instant
 * @returns {{send: boolean, rule: string|null}}
 */
export function decide(candidate, now) {
  validate(candidate, now);

  // Transactional pushes (courier arriving, security code) always go out:
  // they are not counted toward the cap and ignore the quiet window.
  if (candidate.category === 'transactional') {
    return { send: true, rule: null };
  }

  const start = parseHHMM(candidate.quietStart, 'candidate.quietStart');
  const end = parseHHMM(candidate.quietEnd, 'candidate.quietEnd');
  const { date, minutes } = localClock(candidate.timezone, now);

  if (inQuietWindow(minutes, start, end)) {
    return { send: false, rule: 'quiet-hours' };
  }

  const sent = marketingSent.get(candidate.userId);
  const count = sent && sent.date === date ? sent.count : 0;
  if (count >= DAILY_MARKETING_CAP) {
    return { send: false, rule: 'daily-cap' };
  }

  marketingSent.set(candidate.userId, { date, count: count + 1 });
  return { send: true, rule: null };
}
