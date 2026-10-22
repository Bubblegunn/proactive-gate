// SMS send gate for appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// A text may go out only between 08:00 and 20:00 in the patient's own time zone.
// No state and no network: the answer depends only on the arguments.

const WINDOW_START_HOUR = 8;
// Exclusive: 20:00:00 local is already outside the window.
const WINDOW_END_HOUR = 20;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Wall-clock fields of an instant in the given zone. Month is 1-based.
function localParts(instant, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) {
    parts[type] = Number(value);
  }
  return parts;
}

// UTC offset of the zone at this instant, in milliseconds (handles half-hour zones and DST).
function offsetMs(instant, timeZone) {
  const p = localParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

// The real instant at which the zone's wall clock shows the given local date and hour.
function localToInstant(year, monthIndex, day, hour, timeZone) {
  const wall = Date.UTC(year, monthIndex, day, hour);
  const firstGuess = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(firstGuess), timeZone));
}

// Returns the zone name if the runtime knows it, otherwise null.
function resolveZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("checkSms: now must be a valid Date");
  }

  if (!user || typeof user.phone !== "string" || user.phone.trim() === "") {
    return {
      allowed: false,
      reason: "No phone number on file, so no text can be sent.",
      nextAllowedAt: null,
    };
  }

  const zone = resolveZone(user.timezone);
  if (zone === null) {
    return {
      allowed: false,
      reason:
        "Patient has no valid time zone set, so the 08:00-20:00 local-time window cannot be checked. Held until a valid time zone is saved.",
      nextAllowedAt: null,
    };
  }

  const p = localParts(now, zone);
  const clock = `${pad2(p.hour)}:${pad2(p.minute)}`;

  if (p.hour >= WINDOW_START_HOUR && p.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `Within the 08:00-20:00 window in ${zone} (local time ${clock}).`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 we wait for today's 08:00; from 20:00 on we wait for tomorrow's 08:00.
  const dayOffset = p.hour >= WINDOW_END_HOUR ? 1 : 0;
  const nextAllowedAt = localToInstant(p.year, p.month - 1, p.day + dayOffset, WINDOW_START_HOUR, zone);

  return {
    allowed: false,
    reason: `Held by quiet hours: texts go out only 08:00-20:00 local time in ${zone}, and it is ${clock} there now.`,
    nextAllowedAt,
  };
}
