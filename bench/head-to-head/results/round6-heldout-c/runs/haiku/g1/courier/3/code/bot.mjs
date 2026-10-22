// Quiet-hours gate for appointment reminder SMS.
// Pure and stateless: no network, no clock reads (the caller passes `now`),
// no reliance on the machine's own time zone.

// A text may go out only when the patient's local wall-clock time is in
// [WINDOW_START_HOUR:00, WINDOW_END_HOUR:00). Change these two values to
// adjust the window; both are local hours in the patient's time zone.
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 20;

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Wall-clock fields of `instant` as seen in `timeZone`.
function localParts(instant, timeZone) {
  const parts = {};
  for (const { type, value } of getFormatter(timeZone).formatToParts(instant)) {
    parts[type] = Number(value);
  }
  return parts;
}

// Zone offset from UTC in milliseconds at `instant` (positive east of UTC).
function offsetMs(instant, timeZone) {
  const p = localParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = instant.getTime() - instant.getUTCMilliseconds();
  return wallAsUtc - wholeSecond;
}

// Instant at which the zone's wall clock shows year-month-day hour:00.
function zonedWallTimeToInstant(year, month, day, hour, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const firstGuess = wall - offsetMs(new Date(wall), timeZone);
  const corrected = wall - offsetMs(new Date(firstGuess), timeZone);
  return new Date(corrected);
}

// Returns the zone name if Intl accepts it, otherwise null.
function resolveZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return null;
  try {
    getFormatter(timeZone);
    return timeZone;
  } catch {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }

  const phone = user?.phone;
  if (typeof phone !== 'string' || !E164_PATTERN.test(phone)) {
    return {
      allowed: false,
      reason: 'The phone number is not in international format (+country code), so no text can be delivered to it.',
      nextAllowedAt: null,
    };
  }

  const zone = resolveZone(user?.timezone);
  if (zone === null) {
    return {
      allowed: false,
      reason: 'The patient has no valid time zone on file, so their local send window cannot be checked. Texts are held until a valid time zone is set.',
      nextAllowedAt: null,
    };
  }

  const local = localParts(now, zone);
  const clock = `${pad2(local.hour)}:${pad2(local.minute)}`;

  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `It is ${clock} local time in ${zone}, inside the ${pad2(WINDOW_START_HOUR)}:00-${pad2(WINDOW_END_HOUR)}:00 send window.`,
      nextAllowedAt: null,
    };
  }

  // Before the window opens today, or after it closed: next opening is
  // today at the start hour, or tomorrow at the start hour.
  const dayOffset = local.hour >= WINDOW_END_HOUR ? 1 : 0;
  const calendarDay = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
  const opensAt = zonedWallTimeToInstant(
    calendarDay.getUTCFullYear(),
    calendarDay.getUTCMonth() + 1,
    calendarDay.getUTCDate(),
    WINDOW_START_HOUR,
    zone,
  );

  return {
    allowed: false,
    reason: `It is ${clock} local time in ${zone}. Reminder texts only go out between ${pad2(WINDOW_START_HOUR)}:00 and ${pad2(WINDOW_END_HOUR)}:00 local time, so this one is held until ${pad2(WINDOW_START_HOUR)}:00 local time (${opensAt.toISOString()}).`,
    nextAllowedAt: opensAt,
  };
}
