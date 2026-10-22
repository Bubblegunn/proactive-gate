// App-side push gate: customer quiet hours + per-customer daily marketing cap.
// All state is in memory; a restart forgets the counts.
// decide() is synchronous, so its check-and-increment cannot interleave in one process.

const MARKETING_DAILY_CAP = 3;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const dayCounts = new Map(); // userId -> { day: "YYYY-MM-DD" (customer-local), count }
const clockFormatters = new Map(); // timezone -> Intl.DateTimeFormat

function clockFormatter(timezone) {
  let formatter = clockFormatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA timezone name.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timezone, formatter);
  }
  return formatter;
}

// The customer's local calendar day and minute-of-day at the instant `now`.
function localClock(now, timezone) {
  const parts = {};
  for (const part of clockFormatter(timezone).formatToParts(now)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, name) {
  const match = typeof value === "string" ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be a 24-hour "HH:MM" string, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// Start is inclusive, end is exclusive. A window with start > end wraps past midnight.
// start === end means no quiet hours.
function inQuietWindow(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/**
 * Decide whether a push may go out now.
 *
 * @param {{
 *   userId: string,
 *   category: "marketing" | "transactional",
 *   timezone: string,
 *   quietStart: string,
 *   quietEnd: string,
 *   courierWaiting?: boolean,
 * }} candidate
 *   courierWaiting: set true when the customer is waiting for a courier right now.
 *   Such a transactional push ignores quiet hours.
 * @param {Date} now current instant (the caller's clock; not the server's local time)
 * @returns {{ send: boolean, rule: string | null }}
 *   When send is true the push is counted as sent. When false, rule names the rule that blocked it.
 */
export function decide(candidate, now) {
  const { userId, category, timezone, quietStart, quietEnd, courierWaiting = false } = candidate;

  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  if (category !== "marketing" && category !== "transactional") {
    throw new TypeError(`category must be "marketing" or "transactional", got ${JSON.stringify(category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const start = parseHHMM(quietStart, "quietStart");
  const end = parseHHMM(quietEnd, "quietEnd");
  const { day, minute } = localClock(now, timezone);

  const exemptFromQuiet = category === "transactional" && courierWaiting === true;
  if (!exemptFromQuiet && inQuietWindow(minute, start, end)) {
    return { send: false, rule: "quiet-hours" };
  }

  if (category === "marketing") {
    const entry = dayCounts.get(userId);
    const sentToday = entry && entry.day === day ? entry.count : 0;
    if (sentToday >= MARKETING_DAILY_CAP) {
      return { send: false, rule: "daily-cap" };
    }
    dayCounts.set(userId, { day, count: sentToday + 1 });
  }

  return { send: true, rule: null };
}
