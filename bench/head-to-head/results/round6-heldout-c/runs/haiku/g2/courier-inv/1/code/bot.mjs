// Push gate: decides whether one candidate push may go out right now.
// State lives in memory only; a restart forgets all counts.

const DAILY_MARKETING_CAP = 3;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Cached per time zone; creating an Intl.DateTimeFormat is expensive.
const formatters = new Map();

// `${userId}|${localDate}` -> marketing pushes sent that local day.
const marketingCounts = new Map();

// UTC date of the last prune run; prune runs at most once per UTC day.
let lastPruneDay = null;

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
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

// Local calendar date (YYYY-MM-DD) and minutes since local midnight,
// in the customer's time zone. Throws RangeError for an unknown time zone.
function localParts(timezone, now) {
  const parts = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(now)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(value, field) {
  const match = HHMM.exec(value);
  if (!match) {
    throw new TypeError(`${field} must be "HH:MM" (24-hour), got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Window [start, end). If start equals end the window is empty.
// If start is after end the window wraps past midnight.
function inQuietHours(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Drop counts older than two UTC days. Local dates are within a day of the
// UTC date, so no entry that could still be looked up is removed.
function pruneOldCounts(now) {
  const utcDay = now.toISOString().slice(0, 10);
  if (utcDay === lastPruneDay) return;
  lastPruneDay = utcDay;
  const cutoff = shiftDate(utcDay, -2);
  for (const key of marketingCounts.keys()) {
    const date = key.slice(key.lastIndexOf("|") + 1);
    if (date < cutoff) marketingCounts.delete(key);
  }
}

/**
 * @param {{ userId: string, category: "marketing" | "transactional",
 *           timezone: string, quietStart: string, quietEnd: string }} candidate
 * @param {Date} now current instant (caller-supplied; not the server's local clock)
 * @returns {{ send: boolean, rule: string | null }}
 *
 * When send is true the push is counted (marketing only) and the caller must send it.
 * Transactional pushes skip quiet hours and the daily cap.
 */
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

  const start = toMinutes(quietStart, "quietStart");
  const end = toMinutes(quietEnd, "quietEnd");
  const { date, minutes } = localParts(timezone, now);
  pruneOldCounts(now);

  if (category === "transactional") {
    return { send: true, rule: null };
  }

  if (inQuietHours(minutes, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  const key = `${userId}|${date}`;
  const sent = marketingCounts.get(key) ?? 0;
  if (sent >= DAILY_MARKETING_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  marketingCounts.set(key, sent + 1);
  return { send: true, rule: null };
}
