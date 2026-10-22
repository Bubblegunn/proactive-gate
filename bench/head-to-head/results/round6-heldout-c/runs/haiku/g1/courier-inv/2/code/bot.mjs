// Quiet-hours gate for appointment-reminder SMS.
// A text may go out only when the patient's local time is 08:00 to 20:59:59.
// If the patient's time zone is missing or not a recognised IANA name, we
// cannot know the local time, so the text may go out only when the time is
// inside that window in every US time zone at once.
// Pure function: no network, no state, no reliance on the machine's zone.

const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21; // exclusive
const MINUTE_MS = 60 * 1000;
const SEARCH_LIMIT_MS = 3 * 24 * 60 * MINUTE_MS;

const US_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Adak",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
];

const WINDOW_TEXT = `${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00`;

const formatters = new Map();

function hourFormatter(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    // Throws RangeError for an unknown zone name; nothing is cached in that case.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function isKnownZone(zone) {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    hourFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

function localHour(zone, date) {
  const part = hourFormatter(zone)
    .formatToParts(date)
    .find((p) => p.type === "hour");
  return Number(part.value) % 24;
}

function inWindowIn(zone, date) {
  const hour = localHour(zone, date);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

function inWindowEverywhereInUs(date) {
  return US_ZONES.every((zone) => inWindowIn(zone, date));
}

// Earliest minute-aligned instant at or after `now` where isOpen() holds.
// Window edges fall on whole local hours, so minute steps find them exactly.
function firstOpenInstant(now, isOpen) {
  if (isOpen(now)) return now;
  const limit = now.getTime() + SEARCH_LIMIT_MS;
  let t = Math.ceil(now.getTime() / MINUTE_MS) * MINUTE_MS;
  while (t <= limit) {
    const candidate = new Date(t);
    if (isOpen(candidate)) return candidate;
    t += MINUTE_MS;
  }
  return null;
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("checkSms: now must be a valid Date");
  }

  const zone = user?.timezone;
  const known = isKnownZone(zone);
  const isOpen = known
    ? (date) => inWindowIn(zone, date)
    : inWindowEverywhereInUs;

  if (isOpen(now)) {
    return {
      allowed: true,
      reason: known
        ? `Inside the ${WINDOW_TEXT} send window in ${zone}.`
        : `Patient time zone is missing or unrecognised, and it is inside the ${WINDOW_TEXT} window in every US time zone.`,
      nextAllowedAt: null,
    };
  }

  const nextAllowedAt = firstOpenInstant(now, isOpen);
  const why = known
    ? `Outside the ${WINDOW_TEXT} send window in ${zone}.`
    : `Patient time zone is missing or unrecognised (${JSON.stringify(zone ?? null)}), so the text waits until the ${WINDOW_TEXT} window is open in every US time zone.`;
  const reason = nextAllowedAt
    ? `${why} Held until it reopens.`
    : `${why} No opening was found in the next 3 days.`;

  return { allowed: false, reason, nextAllowedAt };
}
