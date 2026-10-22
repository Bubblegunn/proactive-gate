// SMS send gate for appointment reminders.
//
// The scheduler calls checkSms(user, now) before handing a text to the SMS
// vendor. The function is pure: it reads only its arguments, keeps no state,
// and does not touch the network or send anything.
//
// Rule implemented here: a text may go out only between 08:00 (inclusive) and
// 21:00 (exclusive) on the patient's local clock. Outside that window the text
// is held and nextAllowedAt is the next 08:00 local time.
//
// If the phone number is malformed or the time zone is missing/unrecognised,
// the local window cannot be checked, so the text is held with
// nextAllowedAt = null (there is no known time to retry).

const SEND_START_HOUR = 8;
const SEND_END_HOUR = 21;
const E164 = /^\+[1-9]\d{6,14}$/;

function isValidZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of `instant` as seen in `timeZone`.
function localParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// UTC offset in ms of `timeZone` at the instant `ms` (second precision).
function offsetMs(ms, timeZone) {
  const p = localParts(new Date(ms), timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

// UTC instant (ms) at which the wall clock in `timeZone` shows y-mo-d h:00.
function localHourToMs(year, month, day, hour, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetBefore = offsetMs(naive - offsetMs(naive, timeZone), timeZone);
  const guess = naive - offsetBefore;
  // Re-check the offset at the guessed instant (DST boundaries can differ).
  const offsetAtGuess = offsetMs(guess, timeZone);
  return offsetAtGuess === offsetBefore ? guess : naive - offsetAtGuess;
}

function hhmm(p) {
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const WINDOW = `${String(SEND_START_HOUR).padStart(2, '0')}:00–${SEND_END_HOUR}:00`;

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

  if (typeof user.phone !== 'string' || !E164.test(user.phone)) {
    return held(
      'Held: the phone number is missing or not in international (+country code) format, so the text cannot be addressed.',
      null,
    );
  }

  if (!isValidZone(user.timezone)) {
    const reason =
      user.timezone === null || user.timezone === undefined || user.timezone === ''
        ? 'Held: this patient has no time zone set, so the 08:00–21:00 texting window cannot be checked.'
        : `Held: time zone ${JSON.stringify(String(user.timezone))} is not recognised, so the 08:00–21:00 texting window cannot be checked.`;
    return held(reason, null);
  }

  const timeZone = user.timezone;
  const local = localParts(now, timeZone);

  if (local.hour >= SEND_START_HOUR && local.hour < SEND_END_HOUR) {
    return {
      allowed: true,
      reason: `Within the ${WINDOW} texting window in ${timeZone}.`,
      nextAllowedAt: null,
    };
  }

  // Outside the window: next 08:00 local. Before 08:00 that is later today;
  // at or after 21:00 it is tomorrow. Calendar arithmetic goes through UTC so
  // month and year rollover are handled without touching the machine zone.
  const dayShift = local.hour >= SEND_END_HOUR ? 1 : 0;
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + dayShift));
  const nextAllowedAt = new Date(
    localHourToMs(
      target.getUTCFullYear(),
      target.getUTCMonth() + 1,
      target.getUTCDate(),
      SEND_START_HOUR,
      timeZone,
    ),
  );

  return held(
    `Held: it is ${hhmm(local)} in ${timeZone}, outside the ${WINDOW} texting window.`,
    nextAllowedAt,
  );
}
