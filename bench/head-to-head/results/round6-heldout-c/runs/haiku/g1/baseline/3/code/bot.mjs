// Quiet-hours gate for SMS appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// Pure function: no state, no network, no reliance on the machine's time zone.

// Texts go out only between 08:00 (inclusive) and 21:00 (exclusive),
// on the patient's own local clock.
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21;

const E164 = /^\+[1-9]\d{6,14}$/;
// IANA names such as "America/Chicago", "Asia/Kolkata", "UTC", "EST".
// Rejects offset strings like "+05:00", which Intl may accept but are not IANA zones.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

function isValidZone(tz) {
  if (typeof tz !== 'string' || !IANA_NAME.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant, as seen in the given zone.
function localParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23', // avoids "24" for midnight on some ICU versions
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// UTC offset of the zone at instant ms, in milliseconds (east positive).
function offsetMs(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant at which the zone's wall clock first reads y-m-d hh:00.
// Two passes of the offset lookup settle the offset across a DST change.
function wallClockToInstant(year, month, day, hour, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function blocked(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }
  const nowMs = now.getTime();

  const phone = user?.phone;
  if (typeof phone !== 'string' || !E164.test(phone)) {
    return blocked(
      'The phone number is missing or not in +E.164 format, so no text can be sent to it.',
      null,
    );
  }

  const tz = user?.timezone;
  if (!isValidZone(tz)) {
    return blocked(
      'The patient has no valid time zone on file, so quiet hours cannot be checked. ' +
        'The text is held until a time zone is set.',
      null,
    );
  }

  const p = localParts(nowMs, tz);
  const localClock = `${pad2(p.hour)}:${pad2(p.minute)}`;

  if (p.hour >= WINDOW_START_HOUR && p.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `Local time ${localClock} in ${tz} is inside the ${pad2(WINDOW_START_HOUR)}:00-${pad2(WINDOW_END_HOUR)}:00 window.`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 the window opens later today; at or after 21:00 it opens tomorrow.
  let day = { year: p.year, month: p.month, day: p.day };
  if (p.hour >= WINDOW_END_HOUR) {
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  const nextAllowedAt = new Date(
    wallClockToInstant(day.year, day.month, day.day, WINDOW_START_HOUR, tz),
  );

  return blocked(
    `Local time for this patient is ${localClock} in ${tz}. Texts are sent only between ` +
      `${pad2(WINDOW_START_HOUR)}:00 and ${pad2(WINDOW_END_HOUR)}:00 local time. ` +
      `The window next opens at ${nextAllowedAt.toISOString()}.`,
    nextAllowedAt,
  );
}
