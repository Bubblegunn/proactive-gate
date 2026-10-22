// bot.mjs: decides whether an SMS appointment reminder may go out to a patient right now.
// Pure function of (user, now). No state, no network, no reliance on the machine's time zone.

// Quiet hours are judged on the patient's local wall clock.
const WINDOW_START_HOUR = 8; // inclusive: texts may go out from 08:00:00.000 local
const WINDOW_END_HOUR = 21; // exclusive: no texts from 21:00:00.000 local

// E.164: "+", a non-zero country code digit, then 7 to 14 more digits.
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * @param {{ id?: string, phone: string, timezone: string | null }} user
 * @param {Date} now
 * @returns {{ allowed: boolean, reason: string, nextAllowedAt: Date | null }}
 */
export function checkSms(user, now) {
  // Programmer errors throw, so the scheduler fails loudly instead of silently sending or holding.
  if (user === null || typeof user !== 'object') {
    throw new TypeError('checkSms: user must be an object');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }

  // Data problems hold the text. There is no known time to retry, so nextAllowedAt is null.
  if (typeof user.phone !== 'string' || !E164.test(user.phone)) {
    return held(
      'The phone number is not a valid international number (expected a "+", country code and digits), so the text cannot be delivered.',
      null,
    );
  }

  const timeZone = user.timezone;
  if (!isKnownTimeZone(timeZone)) {
    const problem = timeZone == null ? 'The patient has no time zone set' : `The patient's time zone "${timeZone}" is not recognised`;
    return held(
      `${problem}, so their local quiet hours cannot be checked. The text is held until a valid time zone is set.`,
      null,
    );
  }

  const local = wallClock(now, timeZone);
  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `It is ${hhmm(local)} for the patient in ${timeZone}, inside the ${WINDOW_START_HOUR}:00 to ${WINDOW_END_HOUR}:00 texting window.`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 the window opens later today. From 21:00 on it opens tomorrow.
  const opensToday = local.hour < WINDOW_START_HOUR;
  const dayOffset = opensToday ? 0 : 1;
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
  const nextAllowedAt = instantOfLocalTime(
    timeZone,
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth(),
    nextDay.getUTCDate(),
    WINDOW_START_HOUR,
  );

  return held(
    `It is ${hhmm(local)} for the patient in ${timeZone}. Reminder texts go out only from ${WINDOW_START_HOUR}:00 to ${WINDOW_END_HOUR}:00 local time, so this one is held until ${opensToday ? 'today' : 'tomorrow'} at ${WINDOW_START_HOUR}:00 local time.`,
    nextAllowedAt,
  );
}

function held(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

function isKnownTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant as seen in the given IANA zone.
function wallClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const field = (type) => Number(parts.find((part) => part.type === type).value);
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

// UTC offset in ms of the zone at a whole-second instant (ms since epoch).
function offsetMs(instantMs, timeZone) {
  const w = wallClock(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - instantMs;
}

// The instant at which the zone's wall clock first reads hour:00:00 on the given date.
function instantOfLocalTime(timeZone, year, monthIndex, day, hour) {
  const wallMs = Date.UTC(year, monthIndex, day, hour);
  const first = wallMs - offsetMs(wallMs, timeZone);
  // Second pass, because the offset at the first guess can differ from the offset at the answer.
  return new Date(wallMs - offsetMs(first, timeZone));
}

function hhmm(local) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(local.hour)}:${pad(local.minute)}`;
}
