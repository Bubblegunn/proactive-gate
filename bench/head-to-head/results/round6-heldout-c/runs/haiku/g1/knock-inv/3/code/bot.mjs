// SMS send gate for appointment reminders.
// checkSms(user, now) answers: may a text go to this patient right now?
// Pure function: no I/O, no module state, and it never reads the machine's time zone.

// Texts go out only between 08:00 (inclusive) and 21:00 (exclusive) in the patient's local time.
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21;

// E.164: a plus sign, a non-zero country code digit, then 7 to 15 more digits.
const E164 = /^\+[1-9]\d{6,14}$/;

export function checkSms(user, now) {
  if (user === null || typeof user !== 'object') {
    throw new TypeError('checkSms: user must be an object');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }

  if (typeof user.phone !== 'string' || !E164.test(user.phone)) {
    return hold('The phone number is missing or not in E.164 format, so no text can be sent.', null);
  }

  const zone = resolveZone(user.timezone);
  if (zone === null) {
    return hold(
      'No valid time zone is on file for this patient, so local quiet hours cannot be checked. The text is held until a time zone is set.',
      null,
    );
  }

  const formatter = localFormatter(zone);
  const local = wallClock(formatter, now);

  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return { allowed: true, reason: `It is inside the 08:00-21:00 window in ${zone}.`, nextAllowedAt: null };
  }

  // Before 08:00 the window opens later the same day. From 21:00 on, it opens the next calendar day.
  const dayOffset = local.hour >= WINDOW_END_HOUR ? 1 : 0;
  const opensAt = new Date(
    zonedWallTimeToInstant(formatter, local.year, local.month, local.day + dayOffset, WINDOW_START_HOUR),
  );
  const clock = `${pad(local.hour)}:${pad(local.minute)}`;
  return hold(
    `It is ${clock} in ${zone}. Reminder texts are held outside 08:00-21:00 local time.`,
    opensAt,
  );
}

function hold(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

// Returns the canonical IANA name, or null when the value is missing or not a zone this runtime knows.
// Abbreviations such as "CST" are rejected: they are ambiguous (US Central or China Standard Time).
function resolveZone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) {
    return null;
  }
  if (tz !== 'UTC' && !tz.includes('/')) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localFormatter(zone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Wall-clock fields of an instant in the formatter's zone.
function wallClock(formatter, instant) {
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

// The zone's UTC offset in ms at the given instant (positive means ahead of UTC).
function offsetMs(formatter, instant) {
  const w = wallClock(formatter, instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSecond;
}

// Converts a local wall-clock time in the zone to an epoch ms value.
// Day overflow (e.g. day 32) is normalised by Date.UTC. Two passes settle the offset across DST changes.
function zonedWallTimeToInstant(formatter, year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetMs(formatter, new Date(guess));
  return guess - offsetMs(formatter, new Date(first));
}

function pad(n) {
  return String(n).padStart(2, '0');
}
