// Send-window gate for SMS appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// A text goes out only between 08:00 and 21:00 in the patient's own time zone.
// Pure function: no state, no network, no reliance on the machine's time zone.

const WINDOW_START_HOUR = 8; // inclusive
const WINDOW_END_HOUR = 21; // exclusive

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const pad2 = (n) => String(n).padStart(2, '0');

// Returns the IANA zone name if it is usable, otherwise null.
function resolveZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() !== timeZone || timeZone === '') {
    return null;
  }
  // Offset strings such as "+05:00" are not IANA names.
  if (timeZone.startsWith('+') || timeZone.startsWith('-')) {
    return null;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return null;
  }
  return timeZone;
}

function makeFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

// Wall-clock fields of an instant in the formatter's zone.
function localParts(epochMs, formatter) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(epochMs))) {
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

// Offset (ms) of the zone from UTC at the given instant. Whole seconds only,
// because the formatter drops sub-second fields.
function offsetMs(epochMs, formatter) {
  const wholeSecondMs = Math.floor(epochMs / 1000) * 1000;
  const p = localParts(wholeSecondMs, formatter);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecondMs;
}

// Instant at which the zone's wall clock shows year-month-day hour:00:00.
// Two passes so that a DST change between the guess and the result is handled.
function instantForLocal(year, month, day, hour, formatter) {
  const wallMs = Date.UTC(year, month - 1, day, hour);
  const firstGuess = wallMs - offsetMs(wallMs, formatter);
  return wallMs - offsetMs(firstGuess, formatter);
}

function held(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }
  if (user === null || typeof user !== 'object') {
    throw new TypeError('checkSms: user must be an object');
  }

  // Retrying cannot fix a bad number, so no retry time is given.
  if (typeof user.phone !== 'string' || !E164_PATTERN.test(user.phone)) {
    return held(
      'The phone number is missing or not in international format (+ country code and digits), so the text was held.',
      null,
    );
  }

  const timeZone = resolveZone(user.timezone);
  if (timeZone === null) {
    // The local window cannot be computed, and no clock time makes it computable.
    return held(
      'The patient has no valid time zone on file, so their local send window cannot be checked and the text was held.',
      null,
    );
  }

  const formatter = makeFormatter(timeZone);
  const nowMs = now.getTime();
  const local = localParts(nowMs, formatter);
  const localClock = `${pad2(local.hour)}:${pad2(local.minute)}`;

  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `It is ${localClock} in ${timeZone}, inside the 08:00-21:00 local send window.`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 the window opens later today. At or after 21:00 it opens tomorrow.
  const dayShift = local.hour >= WINDOW_END_HOUR ? 1 : 0;
  const nextAllowedAt = new Date(
    instantForLocal(local.year, local.month, local.day + dayShift, WINDOW_START_HOUR, formatter),
  );

  return held(
    `It is ${localClock} in ${timeZone}, outside the 08:00-21:00 local send window, so the text was held. The window opens at ${nextAllowedAt.toISOString()}.`,
    nextAllowedAt,
  );
}
