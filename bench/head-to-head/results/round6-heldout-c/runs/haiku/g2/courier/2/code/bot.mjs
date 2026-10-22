// Push-notification gate. Call decide() right before handing a push to the provider.
// State is in memory only; a restart forgets all counts.
//
// Rules, checked in this order (first hit wins):
//   1. quiet-hours  marketing pushes inside the customer's own do-not-disturb window
//   2. daily-cap    more than 3 marketing pushes already sent today (customer's local day)
// Transactional pushes skip both rules. Only sent marketing pushes are counted.

const MARKETING_DAILY_CAP = 3;
const RETAIN_DAYS = 2;

const sentByUserDay = new Map(); // userId -> Map(localDate "YYYY-MM-DD" -> count)

const dateFormatterCache = new Map();

function localParts(now, timeZone) {
  let fmt = dateFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    dateFormatterCache.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value, field) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof value === "string" ? value : "");
  if (!m) throw new TypeError(`${field} must be "HH:MM" (24h), got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Window is [start, end). If start > end it wraps past midnight.
// start === end means an empty window (no quiet hours).
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function previousDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function sentToday(userId, date) {
  return sentByUserDay.get(userId)?.get(date) ?? 0;
}

function recordSent(userId, date) {
  let days = sentByUserDay.get(userId);
  if (!days) {
    days = new Map();
    sentByUserDay.set(userId, days);
  }
  days.set(date, (days.get(date) ?? 0) + 1);

  // Drop days older than the retention window so memory stays bounded per user.
  let cutoff = date;
  for (let i = 0; i < RETAIN_DAYS; i++) cutoff = previousDay(cutoff);
  for (const d of days.keys()) {
    if (d < cutoff) days.delete(d);
  }
}

export function decide(candidate, now) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate must be an object");
  const { userId, category, timezone, quietStart, quietEnd } = candidate;
  if (typeof userId !== "string" || userId === "") throw new TypeError("userId must be a non-empty string");
  if (category !== "marketing" && category !== "transactional") {
    throw new TypeError(`category must be "marketing" or "transactional", got ${JSON.stringify(category)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now must be a valid Date");

  // Throws RangeError for an unknown IANA zone; that is a caller bug, so let it surface.
  if (typeof timezone !== "string") throw new TypeError("timezone must be an IANA zone name");
  const { date, minutes } = localParts(now, timezone);

  // Transactional pushes (courier arriving, security code) are never blocked here.
  if (category === "transactional") return { send: true, rule: null };

  const start = parseHHMM(quietStart, "quietStart");
  const end = parseHHMM(quietEnd, "quietEnd");
  if (inQuietWindow(minutes, start, end)) return { send: false, rule: "quiet-hours" };

  if (sentToday(userId, date) >= MARKETING_DAILY_CAP) return { send: false, rule: "daily-cap" };

  recordSent(userId, date);
  return { send: true, rule: null };
}
