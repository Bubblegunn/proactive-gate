// SMS send-time gate for appointment reminders.
// Pure: no state, no network. Every check uses the patient's own IANA zone,
// never the machine's zone.

const WINDOW_START_MIN = 8 * 60; // 08:00 local, inclusive
const WINDOW_END_MIN = 21 * 60; // 21:00 local, exclusive

// Wall-clock fields of an instant in a given zone.
function wallClock(instant, timeZone) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const { type, value } of fmt.formatToParts(instant)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

// Instant at which the zone's wall clock reads y-mo-d h:mi.
function wallToInstant(y, mo, d, h, mi, timeZone) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), timeZone);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += target - seen;
  }
  return new Date(guess);
}

function nextCalendarDay({ year, month, day }) {
  const t = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return {
      allowed: false,
      reason: 'Held: the current time is not a valid Date, so the send hour cannot be checked.',
      nextAllowedAt: null,
    };
  }

  const zone = user?.timezone;
  let local;
  try {
    if (typeof zone !== 'string') throw new RangeError('zone is not a string');
    local = wallClock(now, zone);
  } catch {
    return {
      allowed: false,
      reason: `Held: the patient's time zone (${JSON.stringify(zone ?? null)}) is missing or not a recognised IANA zone, so the local send hour cannot be checked. Ask the patient to pick a time zone.`,
      nextAllowedAt: null,
    };
  }

  const minute = local.hour * 60 + local.minute;
  const localTime = `${pad2(local.hour)}:${pad2(local.minute)}`;

  if (minute >= WINDOW_START_MIN && minute < WINDOW_END_MIN) {
    return {
      allowed: true,
      reason: `Inside the 08:00-21:00 text window in ${zone} (local time ${localTime}).`,
      nextAllowedAt: null,
    };
  }

  // Before 08:00 the window opens later today; at or after 21:00 it opens tomorrow.
  const day = minute < WINDOW_START_MIN ? local : nextCalendarDay(local);
  const nextAllowedAt = wallToInstant(day.year, day.month, day.day, 8, 0, zone);

  return {
    allowed: false,
    reason: `Held: it is ${localTime} local time in ${zone}, and texts go out only between 08:00 and 21:00 local time. Next send time: ${nextAllowedAt.toISOString()}.`,
    nextAllowedAt,
  };
}
