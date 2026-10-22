// Decides whether an appointment reminder SMS may go out right now.
// Rule: texts only between 08:00 and 21:00 in the patient's own local time.
// Pure: no network, no state, and it never reads the machine's time zone.

const WINDOW_START_HOUR = 8;
// Exclusive: 21:00:00 is already outside the window.
const WINDOW_END_HOUR = 21;

// Wall-clock fields of `instant` as seen in `timeZone`.
function zoneParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

// Zone offset in ms at `instant` (positive east of UTC).
function offsetMs(instant, timeZone) {
  const p = zoneParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// Real instant at which the local wall clock reads `wallMs` (a Date.UTC-style value).
function wallClockToInstant(wallMs, timeZone) {
  const firstGuess = wallMs - offsetMs(new Date(wallMs), timeZone);
  return wallMs - offsetMs(new Date(firstGuess), timeZone);
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function hhmm(p) {
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return {
      allowed: false,
      reason: 'Held: the current time is missing or invalid, so the send window cannot be checked.',
      nextAllowedAt: null,
    };
  }

  const timeZone = user?.timezone;
  if (!isValidTimeZone(timeZone)) {
    return {
      allowed: false,
      reason: 'Held: this patient has no valid time zone on file, so their local time cannot be checked. Ask them to pick a time zone in the app.',
      nextAllowedAt: null,
    };
  }

  const p = zoneParts(now, timeZone);
  if (p.hour >= WINDOW_START_HOUR && p.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `Allowed: it is ${hhmm(p)} in ${timeZone}, inside the 08:00-21:00 local window.`,
      nextAllowedAt: null,
    };
  }

  // Next 08:00 local: later today if it is before 08:00, otherwise tomorrow.
  const dayOffset = p.hour < WINDOW_START_HOUR ? 0 : 1;
  const wallStartMs = Date.UTC(p.year, p.month - 1, p.day + dayOffset, WINDOW_START_HOUR);
  const nextAllowedAt = new Date(wallClockToInstant(wallStartMs, timeZone));

  return {
    allowed: false,
    reason: `Held: it is ${hhmm(p)} in ${timeZone}, and texts go out only from 08:00 to 21:00 local time. Earliest retry: ${nextAllowedAt.toISOString()}.`,
    nextAllowedAt,
  };
}
