// Per-user push gate for the proactive agent. Call attempt() right before a push.
//
// Rules, checked in this order; the first failing rule sets the reason code:
//   invalid_timezone      user.timeZone is not a valid IANA zone
//   invalid_quiet_hours   quietStart/quietEnd are not both valid HH:MM (or both absent)
//   invalid_daily_cap     dailyCap is not a non-negative integer
//   quiet_hours           the user's local clock is inside their quiet period
//   daily_cap_reached     the user already got dailyCap pushes on their local calendar day
//
// "Day" and "night" are the user's local clock in user.timeZone: not UTC, not the server's clock.
// A "day" is a local calendar day (midnight to midnight), not a rolling 24 hours.
// History is kept in memory only; it does not survive a restart.

const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000; // a local calendar day is at most 25h long; 48h keeps a margin
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone, so only valid zones get cached.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Local calendar date (YYYY-MM-DD) and minute of day (0-1439) of an instant, in a zone.
function localClock(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) parts[type] = value;
  const hour = Number(parts.hour) % 24; // some engines print "24" for midnight
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + Number(parts.minute),
  };
}

// "22:00" -> 1320. Returns null for anything that is not a valid HH:MM string.
function toMinutes(hhmm) {
  if (typeof hhmm !== "string") return null;
  const match = HHMM.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// A window whose start is later than its end runs past midnight: 22:00-07:00 covers 23:30 and 06:00.
// Equal start and end means no quiet period.
function inQuietHours(minuteOfDay, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minuteOfDay >= startMin && minuteOfDay < endMin;
  return minuteOfDay >= startMin || minuteOfDay < endMin;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  // user id -> epoch ms of each push this gate allowed in the last HISTORY_WINDOW_MS
  const sentAt = new Map();

  return {
    attempt(user, now) {
      if (!user || typeof user.id !== "string") throw new TypeError("attempt: user.id must be a string");
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError("attempt: now must be a valid Date");
      }

      const { timeZone, quietStart, quietEnd, dailyCap } = user;

      if (!isValidTimeZone(timeZone)) return deny("invalid_timezone");

      // Both quiet fields absent means the user set no quiet period.
      const hasQuiet = quietStart != null || quietEnd != null;
      const startMin = hasQuiet ? toMinutes(quietStart) : null;
      const endMin = hasQuiet ? toMinutes(quietEnd) : null;
      if (hasQuiet && (startMin === null || endMin === null)) return deny("invalid_quiet_hours");

      if (!Number.isInteger(dailyCap) || dailyCap < 0) return deny("invalid_daily_cap");

      const clock = localClock(now, timeZone);

      if (hasQuiet && inQuietHours(clock.minuteOfDay, startMin, endMin)) return deny("quiet_hours");

      // Drop history older than the window, then count pushes that fall on today's local date.
      const cutoff = now.getTime() - HISTORY_WINDOW_MS;
      const recent = (sentAt.get(user.id) ?? []).filter((t) => t > cutoff);
      const sentToday = recent.filter((t) => localClock(new Date(t), timeZone).dateKey === clock.dateKey).length;

      if (sentToday >= dailyCap) return deny("daily_cap_reached");

      recent.push(now.getTime());
      if (recent.length > 0) sentAt.set(user.id, recent);
      return { allowed: true, reason: null };
    },
  };
}
