// Push notification gate. Decides whether a push may be handed to the provider.
// State is in memory only; a restart forgets all counts.

const DAILY_MARKETING_CAP = 3;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// One formatter per time zone; creating them is expensive.
const formatters = new Map();

function formatterFor(timezone) {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    // Throws RangeError for an unknown IANA zone, which is the desired failure.
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, fmt);
  }
  return fmt;
}

// Returns the customer's local calendar date ("YYYY-MM-DD") and minute of day.
function localClock(now, timezone) {
  const parts = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(now)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseTime(value, name) {
  const m = typeof value === "string" && TIME_RE.exec(value);
  if (!m) {
    throw new TypeError(`${name} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// Inside [start, end) in local minutes. A window whose start is after its end
// runs past midnight. start === end means no quiet window.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

// "userId|YYYY-MM-DD" -> marketing pushes sent that local day.
const marketingSent = new Map();
const KEEP_DAYS = 2;
let lastSweptDate = null;

// Drops counts for local days more than KEEP_DAYS before `date`, so memory
// stays bounded. Runs once per new date, not on every call. Late calls for
// the kept days still find their counts.
function pruneOldDays(date) {
  if (date === lastSweptDate) return;
  lastSweptDate = date;
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  for (const key of marketingSent.keys()) {
    if (key.slice(key.lastIndexOf("|") + 1) < cutoffDate) marketingSent.delete(key);
  }
}

export function decide(candidate, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  if (category !== "marketing" && category !== "transactional") {
    throw new TypeError(`unknown category ${JSON.stringify(category)}`);
  }

  // Transactional pushes (courier outside, security code) are never held back
  // by the marketing cap or the quiet window.
  if (category === "transactional") {
    return { send: true, rule: null };
  }

  const start = parseTime(quietStart, "quietStart");
  const end = parseTime(quietEnd, "quietEnd");
  const { date, minutes } = localClock(now, timezone);

  if (inQuietWindow(minutes, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  pruneOldDays(date);
  const key = `${userId}|${date}`;
  const count = marketingSent.get(key) ?? 0;
  if (count >= DAILY_MARKETING_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  marketingSent.set(key, count + 1);
  return { send: true, rule: null };
}
