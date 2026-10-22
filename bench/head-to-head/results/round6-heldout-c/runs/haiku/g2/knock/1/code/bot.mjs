// Push notification gate. Called by the marketing and order-tracking jobs
// right before a push is handed to the push provider. Nothing is sent here.
//
// Rules, checked in this order:
//   1. transactional -> always send (no quiet-hours check, no daily cap)
//   2. marketing inside the customer's quiet window -> "quiet-hours"
//   3. marketing over 3 sends on the customer's local day -> "daily-cap"
//   4. otherwise send and count it toward the day's cap
//
// State is in memory only. A restart forgets all counts.

const DAILY_MARKETING_CAP = 3;
const KEEP_DAYS = 3; // counts older than this (UTC days) are dropped

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "user|YYYY-MM-DD" -> number of marketing pushes sent that local day
const sentCounts = new Map();

// Local wall-clock parts for `now` in the given IANA zone.
// Throws RangeError if the zone name is not valid.
function localParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

// "HH:MM" -> minutes since local midnight.
function parseTime(value, name) {
  const m = TIME_RE.exec(typeof value === "string" ? value : "");
  if (!m) {
    throw new TypeError(`${name} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

// True when `t` lies in [start, end). A window with start > end runs past
// midnight. start === end is treated as no window at all.
function inQuietWindow(t, start, end) {
  if (start === end) return false;
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;
}

// Drop counts for days well before `now` so the map does not grow forever.
function pruneOldCounts(now) {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  for (const key of sentCounts.keys()) {
    const date = key.slice(key.lastIndexOf("|") + 1);
    if (date < cutoffDate) sentCounts.delete(key);
  }
}

/**
 * @param {{userId: string, category: "marketing" | "transactional",
 *          timezone: string, quietStart: string, quietEnd: string}} candidate
 * @param {Date} now current instant, supplied by the caller
 * @returns {{send: boolean, rule: string | null}}
 */
export function decide(candidate, now) {
  const { userId, category, timezone, quietStart, quietEnd } = candidate;

  if (category !== "marketing" && category !== "transactional") {
    throw new TypeError(`unknown category ${JSON.stringify(category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  if (category === "transactional") {
    return { send: true, rule: null };
  }

  const start = parseTime(quietStart, "quietStart");
  const end = parseTime(quietEnd, "quietEnd");
  const local = localParts(now, timezone);

  if (inQuietWindow(local.minutes, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  const key = `${userId}|${local.date}`;
  const count = sentCounts.get(key) ?? 0;
  if (count >= DAILY_MARKETING_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  sentCounts.set(key, count + 1);
  pruneOldCounts(now);
  return { send: true, rule: null };
}
