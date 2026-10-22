// SMS send gate for appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// Pure function: no state, no network, no reliance on the machine's time zone.

// Local send window, patient's wall clock. Start inclusive, end exclusive.
// Narrower than the 08:00–21:00 TCPA limit on purpose: these texts were not requested one by one.
const SEND_START_HOUR = 9;
const SEND_END_HOUR = 20;

// E.164: "+" then a non-zero country code digit, 7 to 14 more digits.
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

// IANA names look like "America/Chicago", "Asia/Kolkata", "Etc/GMT+5", or "UTC".
const IANA_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+\-]+)+)$/;

const formatters = new Map();

function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

// Wall-clock fields of an instant as seen in the given zone.
function wallClock(instantMs, zone) {
  const parts = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

// Zone offset in ms at an instant (positive when the zone is ahead of UTC).
function offsetAt(instantMs, zone) {
  const w = wallClock(instantMs, zone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

// Instant at which the zone's wall clock shows the given local date and hour.
// Two passes so the offset is re-read at the candidate instant, which covers DST changes.
function instantOfLocalHour(year, month, day, hour, zone) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = wallAsUtc - offsetAt(wallAsUtc, zone);
  return wallAsUtc - offsetAt(first, zone);
}

function resolveZone(timezone) {
  if (typeof timezone !== 'string' || !IANA_PATTERN.test(timezone)) return null;
  try {
    formatterFor(timezone);
    return timezone;
  } catch {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function hold(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }

  const phone = user?.phone;
  if (typeof phone !== 'string' || !E164_PATTERN.test(phone)) {
    // Retrying will not fix a bad number, so there is no retry time.
    return hold('The phone number is missing or not in +country-code form, so the text cannot be addressed.', null);
  }

  const zone = resolveZone(user?.timezone);
  if (!zone) {
    // Without a zone the local window cannot be checked, and no time can be predicted.
    return hold('The patient has no valid time zone on file, so the local send window cannot be checked and the text is held.', null);
  }

  const local = wallClock(now.getTime(), zone);
  const localTime = `${pad2(local.hour)}:${pad2(local.minute)}`;
  const windowText = `${pad2(SEND_START_HOUR)}:00–${pad2(SEND_END_HOUR)}:00`;

  if (local.hour >= SEND_START_HOUR && local.hour < SEND_END_HOUR) {
    return {
      allowed: true,
      reason: `Local time is ${localTime} in ${zone}, inside the ${windowText} send window.`,
      nextAllowedAt: null,
    };
  }

  // Before the window: same local date. At or after the window end: next local date.
  let targetYear = local.year;
  let targetMonth = local.month;
  let targetDay = local.day;
  if (local.hour >= SEND_END_HOUR) {
    const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    targetYear = nextDate.getUTCFullYear();
    targetMonth = nextDate.getUTCMonth() + 1;
    targetDay = nextDate.getUTCDate();
  }

  const nextAllowedAt = new Date(
    instantOfLocalHour(targetYear, targetMonth, targetDay, SEND_START_HOUR, zone),
  );
  return hold(
    `Local time is ${localTime} on ${local.weekday} in ${zone}, outside the ${windowText} send window; held until ${nextAllowedAt.toISOString()} (${pad2(SEND_START_HOUR)}:00 local).`,
    nextAllowedAt,
  );
}
