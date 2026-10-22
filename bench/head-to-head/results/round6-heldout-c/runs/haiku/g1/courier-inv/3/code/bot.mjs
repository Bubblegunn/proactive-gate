// Decides whether an SMS reminder may go to a patient right now.
// Rule: texts only between 08:00 and 21:00 in the patient's local time zone.
// Pure function: no state, no network, no reliance on the machine's time zone.

const WINDOW_START = 8 * 60; // 08:00 local, minutes after midnight (inclusive)
const WINDOW_END = 21 * 60; // 21:00 local (exclusive)
const MINUTE_MS = 60 * 1000;
const MAX_SCAN_MINUTES = 3 * 24 * 60;

// Used when the patient has no usable time zone but the number is a US number.
// The window must hold in every zone here at the same moment.
const US_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Adak',
  'Pacific/Honolulu',
];

const US_NUMBER = /^\+1\d{10}$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function isValidZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Local wall-clock time of the instant `ms` in `timeZone`.
function localClock(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(ms);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return { hour, minute };
}

function formatClock({ hour, minute }) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// True when the instant is inside the window in every given zone.
function inWindowEverywhere(ms, zones) {
  return zones.every((zone) => {
    const { hour, minute } = localClock(ms, zone);
    const minuteOfDay = hour * 60 + minute;
    return minuteOfDay >= WINDOW_START && minuteOfDay < WINDOW_END;
  });
}

// Earliest whole-minute instant after `ms` at which the window is open in every zone.
// Offsets are whole minutes, so a zone's local clock only changes on minute boundaries.
function nextOpening(ms, zones) {
  let candidate = (Math.floor(ms / MINUTE_MS) + 1) * MINUTE_MS;
  for (let i = 0; i < MAX_SCAN_MINUTES; i++, candidate += MINUTE_MS) {
    if (inWindowEverywhere(candidate, zones)) return new Date(candidate);
  }
  return null;
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }
  const ms = now.getTime();
  const timezone = user?.timezone;
  const hasZone = isValidZone(timezone);
  const phone = user?.phone;

  if (!hasZone && !(typeof phone === 'string' && US_NUMBER.test(phone))) {
    return {
      allowed: false,
      reason:
        'No valid time zone on file and the number is not a US number, so the local send hours cannot be checked.',
      nextAllowedAt: null,
    };
  }

  const zones = hasZone ? [timezone] : US_ZONES;

  if (inWindowEverywhere(ms, zones)) {
    return {
      allowed: true,
      reason: hasZone
        ? `Within 08:00-21:00 local time in ${timezone}.`
        : 'No valid time zone on file; it is within 08:00-21:00 in every US time zone.',
      nextAllowedAt: null,
    };
  }

  const nextAllowedAt = nextOpening(ms, zones);
  const reason = hasZone
    ? `Held: it is ${formatClock(localClock(ms, timezone))} in ${timezone}, and texts go out only between 08:00 and 21:00 local time.`
    : 'Held: no valid time zone on file, and it is outside 08:00-21:00 in at least one US time zone.';

  return { allowed: false, reason, nextAllowedAt };
}
