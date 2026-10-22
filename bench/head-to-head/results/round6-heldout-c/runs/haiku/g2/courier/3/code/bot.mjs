// Push-notification gate. Call decide() right before handing a push to the provider.
// State is in memory only; a restart forgets all counts.

const MARKETING_DAILY_CAP = 3;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// userId -> Map<localDate "YYYY-MM-DD", count of marketing pushes sent>
const sentCounts = new Map();

// One Intl formatter per IANA zone; constructing them is slow.
const formatters = new Map();

function formatterFor(timezone) {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    // Throws RangeError for an unknown time zone name.
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

// Returns the customer's local calendar date and minute-of-day at instant `now`.
function localClock(now, timezone) {
  const parts = {};
  for (const p of formatterFor(timezone).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseMinute(value, field) {
  const m = typeof value === "string" ? TIME_RE.exec(value) : null;
  if (!m) {
    throw new TypeError(`${field} must be "HH:MM" (24-hour), got ${JSON.stringify(value)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// Quiet window [start, end) in minutes. Wraps past midnight when start > end.
// start === end means no quiet window.
function inQuietWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

// Drops per-day counts older than yesterday for one user, so memory stays bounded.
function pruneOldDays(dayCounts, today) {
  const yesterday = previousDate(today);
  for (const date of dayCounts.keys()) {
    if (date < yesterday) dayCounts.delete(date);
  }
}

// Calendar arithmetic on "YYYY-MM-DD" without touching the server time zone.
function previousDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d - 1);
  return new Date(t).toISOString().slice(0, 10);
}

export function decide(candidate, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  if (category !== "marketing" && category !== "transactional") {
    throw new TypeError(`category must be "marketing" or "transactional", got ${JSON.stringify(category)}`);
  }

  // Transactional pushes (courier arriving, security code) always go out.
  // They are not counted against the marketing cap.
  if (category === "transactional") {
    return { send: true, rule: null };
  }

  const start = parseMinute(quietStart, "quietStart");
  const end = parseMinute(quietEnd, "quietEnd");
  const { date, minute } = localClock(now, timezone);

  if (inQuietWindow(minute, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  let dayCounts = sentCounts.get(userId);
  if (!dayCounts) {
    dayCounts = new Map();
    sentCounts.set(userId, dayCounts);
  }
  pruneOldDays(dayCounts, date);

  const sentToday = dayCounts.get(date) ?? 0;
  if (sentToday >= MARKETING_DAILY_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  // decide() is synchronous, so check-and-increment cannot interleave with another call.
  dayCounts.set(date, sentToday + 1);
  return { send: true, rule: null };
}
