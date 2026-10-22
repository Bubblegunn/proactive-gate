// Push gate: decides whether one push may go out now.
// State is in memory only; a restart forgets all counts.

const MARKETING_DAILY_CAP = 3;

// userId -> { day: "YYYY-MM-DD" (customer-local), count: marketing pushes sent that day }
const marketingCounts = new Map();

const formatters = new Map();

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA time zone name.
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// Customer-local calendar day and minute-of-day for the instant `now`.
function localParts(timezone, now) {
  const parts = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(now)) {
    parts[type] = value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, field) {
  const match = typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be "HH:MM" 24-hour time, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Window is [start, end). If start === end there is no window.
// If start > end the window runs past midnight.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function validate(candidate, now) {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("candidate must be an object");
  }
  if (typeof candidate.userId !== "string" || candidate.userId === "") {
    throw new TypeError("candidate.userId must be a non-empty string");
  }
  if (candidate.category !== "marketing" && candidate.category !== "transactional") {
    throw new TypeError(`candidate.category must be "marketing" or "transactional", got ${JSON.stringify(candidate.category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  return {
    start: parseHHMM(candidate.quietStart, "candidate.quietStart"),
    end: parseHHMM(candidate.quietEnd, "candidate.quietEnd"),
  };
}

/**
 * @param {{userId: string, category: "marketing"|"transactional", timezone: string,
 *          quietStart: string, quietEnd: string}} candidate
 * @param {Date} now current instant (caller-supplied; server clock is not used for customer time)
 * @returns {{send: boolean, rule: string|null}}
 */
export function decide(candidate, now) {
  const { start, end } = validate(candidate, now);
  const { day, minutes } = localParts(candidate.timezone, now);

  // Transactional pushes (courier arriving, security codes) are never held back.
  if (candidate.category === "transactional") {
    return { send: true, rule: null };
  }

  if (inQuietWindow(minutes, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  const entry = marketingCounts.get(candidate.userId);
  const count = entry && entry.day === day ? entry.count : 0;
  if (count >= MARKETING_DAILY_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  // Count only pushes that are actually allowed to go out.
  marketingCounts.set(candidate.userId, { day, count: count + 1 });
  return { send: true, rule: null };
}
