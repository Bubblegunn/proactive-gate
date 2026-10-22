// Push-notification gate. Called by the marketing and order-tracking jobs right
// before a push is handed to the push provider. Does not send anything itself.
//
// State is kept in memory only; a restart forgets the daily counts.
//
// Rule order (first match wins, the returned `rule` names it):
//   1. quiet-hours  marketing only; the customer's own do-not-disturb window,
//                   evaluated in the customer's local time
//   2. daily-cap    marketing only; at most DAILY_MARKETING_CAP sent marketing
//                   pushes per customer per customer-local calendar day
//
// Transactional pushes (courier, security code, ...) bypass both rules.

const DAILY_MARKETING_CAP = 3;

// userId -> { day: "YYYY-MM-DD" (customer-local), count: number }
// Only the current local day is kept per user, so the map is bounded by the
// number of users and no pruning is needed.
const sentToday = new Map();

const formatterCache = new Map();

function getFormatter(timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA time zone name.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

// Returns the customer's local calendar date ("YYYY-MM-DD") and local
// minutes since midnight for the instant `now`.
function localParts(timezone, now) {
  const parts = {};
  for (const { type, value } of getFormatter(timezone).formatToParts(now)) {
    parts[type] = value;
  }
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { day, minutes };
}

function parseHHMM(value, name) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!match) {
    throw new TypeError(`${name} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when `minutes` lies in the window [start, end). The window may wrap
// past midnight (start > end). start === end means an empty window.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * @param {{userId: string, category: "marketing"|"transactional", timezone: string,
 *          quietStart: string, quietEnd: string}} candidate
 * @param {Date} now current instant (caller-supplied; not the server clock)
 * @returns {{send: boolean, rule: string|null}}
 */
export function decide(candidate, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (typeof candidate?.userId !== "string" || candidate.userId === "") {
    throw new TypeError("candidate.userId must be a non-empty string");
  }

  // Transactional: always sent, not counted against the marketing cap.
  if (candidate.category === "transactional") {
    return { send: true, rule: null };
  }
  if (candidate.category !== "marketing") {
    throw new TypeError(`unknown category ${JSON.stringify(candidate.category)}`);
  }

  const { day, minutes } = localParts(candidate.timezone, now);
  const quietStart = parseHHMM(candidate.quietStart, "quietStart");
  const quietEnd = parseHHMM(candidate.quietEnd, "quietEnd");

  if (inQuietWindow(minutes, quietStart, quietEnd)) {
    return { send: false, rule: "quiet-hours" };
  }

  let entry = sentToday.get(candidate.userId);
  if (!entry || entry.day !== day) {
    entry = { day, count: 0 };
    sentToday.set(candidate.userId, entry);
  }
  if (entry.count >= DAILY_MARKETING_CAP) {
    return { send: false, rule: "daily-cap" };
  }

  entry.count += 1;
  return { send: true, rule: null };
}
