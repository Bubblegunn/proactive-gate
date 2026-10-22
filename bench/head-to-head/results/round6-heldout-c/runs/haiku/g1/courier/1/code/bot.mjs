// bot.mjs: decides whether an SMS appointment reminder may go out to a patient right now.
//
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// Pure and stateless: no network, no storage, and no reliance on the machine's time zone.
// Local time is always computed from user.timezone via Intl.

// Texts go out only between 08:00 (inclusive) and 21:00 (exclusive) on the patient's local clock.
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21;

// E.164: a leading "+", a non-zero country code digit, then 7 to 14 more digits.
const E164 = /^\+[1-9]\d{7,14}$/;

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
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
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant (epoch ms) as seen in the given time zone.
function wallParts(epochMs, timeZone) {
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(epochMs)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// UTC offset in ms of the time zone at the given instant (positive means ahead of UTC).
function offsetMs(epochMs, timeZone) {
  const w = wallParts(epochMs, timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecondMs = Math.floor(epochMs / 1000) * 1000;
  return wallAsUtc - wholeSecondMs;
}

// The instant whose local wall clock reads wallAsUtcMs (a wall time expressed as UTC ms).
// Two passes so the offset is taken at the right side of a DST change.
function instantForWallClock(wallAsUtcMs, timeZone) {
  const firstGuess = wallAsUtcMs - offsetMs(wallAsUtcMs, timeZone);
  return wallAsUtcMs - offsetMs(firstGuess, timeZone);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clockText(w) {
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

function blocked(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: "now" must be a valid Date');
  }
  const nowMs = now.getTime();

  // Without a usable number there is nothing to send to. Waiting will not fix this.
  if (!user || typeof user.phone !== 'string' || !E164.test(user.phone)) {
    return blocked(
      'No valid phone number on file (expected international format such as +13125550142), so the text is held.',
      null,
    );
  }

  // Without a usable time zone we cannot tell whether it is night for the patient, so we hold the text.
  // Waiting will not fix this either; someone has to fix the patient's time zone.
  if (!isValidTimeZone(user.timezone)) {
    const shown = user.timezone == null || user.timezone === ''
      ? 'no time zone is set'
      : `the time zone "${user.timezone}" is not recognised`;
    return blocked(
      `The patient's local time is unknown because ${shown}, so quiet hours cannot be checked and the text is held.`,
      null,
    );
  }

  const timeZone = user.timezone;
  const local = wallParts(nowMs, timeZone);

  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return {
      allowed: true,
      reason: `Within the ${pad2(WINDOW_START_HOUR)}:00-${pad2(WINDOW_END_HOUR)}:00 texting window (it is ${clockText(local)} in ${timeZone}).`,
      nextAllowedAt: null,
    };
  }

  // Outside the window: the next allowed moment is 08:00 local on today's date (if it is before 08:00)
  // or on tomorrow's date (if it is 21:00 or later). Date.UTC handles month and year rollover.
  const dayOffset = local.hour >= WINDOW_END_HOUR ? 1 : 0;
  const openWallMs = Date.UTC(local.year, local.month - 1, local.day + dayOffset, WINDOW_START_HOUR, 0, 0);
  const nextAllowedAt = new Date(instantForWallClock(openWallMs, timeZone));

  const opensLabel = `${pad2(WINDOW_START_HOUR)}:00 ${dayOffset ? 'tomorrow' : 'today'} (${timeZone} time)`;
  return blocked(
    `Held because it is ${clockText(local)} in ${timeZone}, outside the ${pad2(WINDOW_START_HOUR)}:00-${pad2(WINDOW_END_HOUR)}:00 texting window. Earliest send: ${opensLabel}.`,
    nextAllowedAt,
  );
}
