// Quiet-hours gate for appointment reminder SMS.
//
// A text may go out only when the patient's local clock reads between
// 09:00 (inclusive) and 20:00 (exclusive). The scheduler calls checkSms
// right before it hands a reminder to the SMS vendor.
//
// Pure and stateless: no network, no reads of the machine's time zone.
// All local-time math goes through Intl with the patient's IANA zone.

const WINDOW_OPEN_HOUR = 9;
const WINDOW_CLOSE_HOUR = 20;
const ONE_MINUTE_MS = 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

const formatterCache = new Map();

// Throws RangeError when the zone name is not recognised.
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Wall-clock fields of an instant as seen in the given zone.
function wallClock(instantMs, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
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

// The wall-clock reading of an instant, expressed as if it were UTC.
function wallAsUtcMs(instantMs, timeZone) {
  const w = wallClock(instantMs, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

// Zone offset in ms at an instant (may be negative, may be 30 or 45 min).
function offsetMs(instantMs, timeZone) {
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  return wallAsUtcMs(wholeSecondMs, timeZone) - wholeSecondMs;
}

// Instant whose wall-clock reading is wallMs (a Date.UTC-style value).
// Two passes so that a DST offset change between guess and answer is handled.
function instantForWall(wallMs, timeZone) {
  const firstGuess = wallMs - offsetMs(wallMs, timeZone);
  return wallMs - offsetMs(firstGuess, timeZone);
}

function isOpenAt(instantMs, timeZone) {
  const { hour } = wallClock(instantMs, timeZone);
  return hour >= WINDOW_OPEN_HOUR && hour < WINDOW_CLOSE_HOUR;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clockText(w) {
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

function held(reason, nextAllowedAt) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return held("The current time could not be read, so the text is held.", null);
  }

  const timeZone = user?.timezone;
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    return held(
      "No time zone is set for this patient, so quiet hours cannot be checked. The text is held until a time zone is set.",
      null,
    );
  }

  try {
    formatterFor(timeZone);
  } catch {
    return held(
      `The time zone "${timeZone}" is not recognised, so quiet hours cannot be checked. The text is held until a valid time zone is set.`,
      null,
    );
  }

  const nowMs = now.getTime();
  const local = wallClock(nowMs, timeZone);

  if (isOpenAt(nowMs, timeZone)) {
    return {
      allowed: true,
      reason: `It is ${clockText(local)} in ${timeZone}, inside the 09:00-20:00 window.`,
      nextAllowedAt: null,
    };
  }

  // Closed now. Next opening is 09:00 today if it is before 09:00, else 09:00 tomorrow.
  const dayShift = local.hour < WINDOW_OPEN_HOUR ? 0 : 1;
  const openWallMs = Date.UTC(local.year, local.month - 1, local.day + dayShift, WINDOW_OPEN_HOUR, 0, 0);

  // Step forward minute by minute in case the zone's transition rules
  // moved the candidate. Never returns an instant that is not inside the window.
  let nextMs = instantForWall(openWallMs, timeZone);
  const searchLimitMs = nowMs + TWO_DAYS_MS;
  while (!isOpenAt(nextMs, timeZone) && nextMs < searchLimitMs) {
    nextMs += ONE_MINUTE_MS;
  }
  if (!isOpenAt(nextMs, timeZone) || nextMs <= nowMs) {
    return held(
      `It is ${clockText(local)} in ${timeZone}, outside the 09:00-20:00 window. The next opening could not be determined.`,
      null,
    );
  }

  return held(
    `It is ${clockText(local)} in ${timeZone}. Texts go out only between 09:00 and 20:00 local time.`,
    new Date(nextMs),
  );
}
