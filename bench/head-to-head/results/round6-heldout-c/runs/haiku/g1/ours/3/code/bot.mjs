// Decides whether one appointment-reminder SMS may go to one patient right now.
// Pure function: no state, no network, and it never uses the machine's own time zone.

// Texts go only between 08:00 (inclusive) and 21:00 (exclusive) in the patient's local time.
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 21;

// E.164: "+" then a non-zero country code digit, 8 to 15 digits in total.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function blocked(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

// Returns a formatter, or null when the zone name is missing or not recognised.
function makeFormatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }
}

// Wall-clock fields (year, month 1-12, day, hour 0-23, minute, second) of an instant in the zone.
function localFields(formatter, ms) {
  const fields = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return fields;
}

// Zone offset in milliseconds at the given instant (positive means ahead of UTC).
function offsetMs(formatter, ms) {
  const f = localFields(formatter, ms);
  const wallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

// The exact instant at which the zone's wall clock reads y-mo-d h:mi.
// Day overflow (for example day 32) is handled by Date.UTC.
function instantOfLocal(formatter, y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const firstGuess = wall - offsetMs(formatter, wall);
  return wall - offsetMs(formatter, firstGuess);
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return blocked('The current time is missing or invalid, so the send window cannot be checked. The text is held.', null);
  }

  const phone = user?.phone;
  if (typeof phone !== 'string' || !E164_PATTERN.test(phone)) {
    return blocked('The patient phone number is not in valid international (E.164) format, so no text can be delivered to it.', null);
  }

  const zone = user.timezone;
  const formatter = makeFormatter(zone);
  if (!formatter) {
    const shown = typeof zone === 'string' && zone.length > 0 ? `"${zone}" is not a recognised time zone` : 'No time zone is set';
    return blocked(
      `${shown} for this patient, so their local send hours cannot be checked. The text is held until a valid time zone is on file.`,
      null,
    );
  }

  const f = localFields(formatter, now.getTime());
  const localTime = `${pad2(f.hour)}:${pad2(f.minute)}`;

  if (f.hour >= SEND_START_HOUR && f.hour < SEND_END_HOUR) {
    return {
      allowed: true,
      reason: `Local time in ${zone} is ${localTime}, inside the ${pad2(SEND_START_HOUR)}:00-${SEND_END_HOUR}:00 send window.`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 the window opens later today; at or after 21:00 it opens tomorrow.
  const dayOffset = f.hour < SEND_START_HOUR ? 0 : 1;
  const nextAllowedAt = new Date(
    instantOfLocal(formatter, f.year, f.month, f.day + dayOffset, SEND_START_HOUR, 0),
  );

  return blocked(
    `Local time in ${zone} is ${localTime}. Reminder texts are held outside ${pad2(SEND_START_HOUR)}:00-${SEND_END_HOUR}:00 local time, so the next allowed send is at ${nextAllowedAt.toISOString()}.`,
    nextAllowedAt,
  );
}
