// Push gate: decides whether a push may go to the provider right now.
// State is in memory only; a restart forgets the daily counts.

const DAILY_MARKETING_CAP = 3;
const CATEGORIES = new Set(["marketing", "transactional"]);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Per-user counts of marketing pushes, keyed by the customer's local date.
// Map<userId, Map<"YYYY-MM-DD", count>>
const marketingCounts = new Map();

const dateFormatters = new Map();
const timeFormatters = new Map();

function dateFormatter(timeZone) {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, f);
  }
  return f;
}

function timeFormatter(timeZone) {
  let f = timeFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(timeZone, f);
  }
  return f;
}

// Returns the customer's local calendar day as "YYYY-MM-DD".
function localDay(now, timeZone) {
  const parts = dateFormatter(timeZone).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Returns the customer's local time as minutes since local midnight.
function localMinutes(now, timeZone) {
  const parts = timeFormatter(timeZone).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return Number(get("hour")) * 60 + Number(get("minute"));
}

function parseHHMM(value, field) {
  if (typeof value !== "string" || !HHMM.test(value)) {
    throw new TypeError(`${field} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  }
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

// True when the local time falls inside the customer's do-not-disturb window.
// The window may cross midnight (start > end). start === end means no window.
function inQuietWindow(minutes, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

function validate(candidate, now) {
  if (candidate === null || typeof candidate !== "object") {
    throw new TypeError("candidate must be an object");
  }
  if (typeof candidate.userId !== "string" || candidate.userId === "") {
    throw new TypeError("candidate.userId must be a non-empty string");
  }
  if (!CATEGORIES.has(candidate.category)) {
    throw new TypeError(`candidate.category must be "marketing" or "transactional", got ${JSON.stringify(candidate.category)}`);
  }
  if (typeof candidate.timezone !== "string") {
    throw new TypeError("candidate.timezone must be an IANA time zone name");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
}

// Decides one push. Rules are checked in order; the first one that stops the
// push is the reported rule. Transactional pushes skip the quiet-hours and
// daily-cap rules so a courier or security code always gets through.
export function decide(candidate, now) {
  validate(candidate, now);

  // Throws RangeError for an unknown time zone; that is a caller bug.
  const day = localDay(now, candidate.timezone);

  if (candidate.category === "marketing") {
    const startMin = parseHHMM(candidate.quietStart, "candidate.quietStart");
    const endMin = parseHHMM(candidate.quietEnd, "candidate.quietEnd");
    const minutes = localMinutes(now, candidate.timezone);

    if (inQuietWindow(minutes, startMin, endMin)) {
      return { send: false, rule: "quiet-hours" };
    }

    const days = marketingCounts.get(candidate.userId) ?? new Map();
    const sentToday = days.get(day) ?? 0;
    if (sentToday >= DAILY_MARKETING_CAP) {
      return { send: false, rule: "daily-cap" };
    }

    days.set(day, sentToday + 1);
    // Drop days older than the current one so memory stays bounded per user.
    for (const key of days.keys()) {
      if (key < day) days.delete(key);
    }
    marketingCounts.set(candidate.userId, days);
  }

  return { send: true, rule: null };
}
