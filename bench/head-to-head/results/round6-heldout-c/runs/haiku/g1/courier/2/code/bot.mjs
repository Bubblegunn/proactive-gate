// SMS send gate for appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// Pure function: no state, no network, no reliance on the machine's time zone.

// Texts may go out only between 08:00 (inclusive) and 21:00 (exclusive),
// on the patient's own local clock. This matches the US federal TCPA window.
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 21;

const formatters = new Map();

// Returns a formatter for the zone, or null if the zone is not a valid IANA name.
function getFormatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

// Wall-clock fields of an instant as seen in the zone.
function localFields(instant, formatter) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

// Offset in ms between the zone's wall clock and UTC at this instant.
function offsetAt(instant, formatter) {
  const f = localFields(instant, formatter);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The instant at which the zone's wall clock reads year-month-day hour:00.
// Corrects for the offset in force at the target moment, so DST and
// half-hour zones both resolve to the right instant.
function wallClockToInstant(year, month, day, hour, formatter) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const firstOffset = offsetAt(new Date(guess), formatter);
  let result = guess - firstOffset;
  const secondOffset = offsetAt(new Date(result), formatter);
  if (secondOffset !== firstOffset) {
    result = guess - secondOffset;
  }
  return new Date(result);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return {
      allowed: false,
      reason: 'Held: the current time is invalid, so quiet hours cannot be checked.',
      nextAllowedAt: null,
    };
  }

  const timeZone = user?.timezone;
  const formatter = getFormatter(timeZone);
  if (!formatter) {
    // Without a valid zone we cannot know the patient's local clock, and we
    // cannot predict when they will set one, so there is no retry time.
    return {
      allowed: false,
      reason: 'Held: the patient has no valid time zone on file, so their local quiet hours cannot be checked.',
      nextAllowedAt: null,
    };
  }

  const local = localFields(now, formatter);
  const clock = `${pad(local.hour)}:${pad(local.minute)}`;

  if (local.hour >= SEND_START_HOUR && local.hour < SEND_END_HOUR) {
    return {
      allowed: true,
      reason: `Within ${pad(SEND_START_HOUR)}:00–${pad(SEND_END_HOUR)}:00 local time (it is ${clock} in ${timeZone}).`,
      nextAllowedAt: null,
    };
  }

  const window = `${pad(SEND_START_HOUR)}:00 to ${pad(SEND_END_HOUR)}:00`;

  if (local.hour < SEND_START_HOUR) {
    // Too early: the next window opens later today.
    const nextAllowedAt = wallClockToInstant(
      local.year, local.month, local.day, SEND_START_HOUR, formatter,
    );
    return {
      allowed: false,
      reason: `Held: it is ${clock} in ${timeZone}; reminders go out only from ${window} local time.`,
      nextAllowedAt,
    };
  }

  // Too late: the next window opens at 08:00 on the next calendar day.
  // Date.UTC does the calendar arithmetic (month and year rollover) on plain Y-M-D.
  const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const nextAllowedAt = wallClockToInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    SEND_START_HOUR,
    formatter,
  );
  return {
    allowed: false,
    reason: `Held: it is ${clock} in ${timeZone}; reminders go out only from ${window} local time.`,
    nextAllowedAt,
  };
}
