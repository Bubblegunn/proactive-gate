// SMS send gate for appointment reminders.
// The scheduler calls checkSms(user, now) before handing a text to the SMS vendor.
// Pure and synchronous: no network, no state, and it never reads the machine's own time zone.

// Texts go out only between these hours, in the patient's local time.
const WINDOW_START_HOUR = 9; // inclusive
const WINDOW_END_HOUR = 20; // exclusive

const E164 = /^\+[1-9]\d{7,14}$/;

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (h, m) => `${pad2(h)}:${pad2(m)}`;

function isValidTimeZone(tz) {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant (epoch ms) in the given zone.
function localFields(ms, timeZone) {
  const fields = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  for (const p of parts) fields[p.type] = Number(p.value);
  fields.hour %= 24;
  return fields;
}

// UTC offset of the zone at an instant, in ms. Handles half-hour and 45-minute zones.
function offsetMs(ms, timeZone) {
  const f = localFields(ms, timeZone);
  const wallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

function holdUntilWindow(nowMs, timeZone) {
  // Earliest instant at which the local clock reads WINDOW_START_HOUR:00.
  // Today if we are before the window opens, otherwise tomorrow.
  const local = localFields(nowMs, timeZone);
  const dayShift = local.hour >= WINDOW_START_HOUR ? 1 : 0;
  const targetWallMs = Date.UTC(local.year, local.month - 1, local.day + dayShift, WINDOW_START_HOUR, 0, 0);

  // Two passes so the offset is correct at the target instant, even across a DST change.
  let candidate = targetWallMs - offsetMs(nowMs, timeZone);
  candidate = targetWallMs - offsetMs(candidate, timeZone);

  const check = localFields(candidate, timeZone);
  if (check.hour !== WINDOW_START_HOUR || check.minute !== 0 || candidate <= nowMs) return null;
  return new Date(candidate);
}

export function checkSms(user, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("checkSms: now must be a valid Date");
  }

  const phone = user?.phone;
  if (typeof phone !== "string" || !E164.test(phone)) {
    return { allowed: false, reason: "No valid phone number (E.164) on file, so the text cannot be sent.", nextAllowedAt: null };
  }

  const timeZone = user.timezone;
  if (!isValidTimeZone(timeZone)) {
    return {
      allowed: false,
      reason: "No valid time zone on file for this patient, so their local send hours cannot be checked. Held until a time zone is set.",
      nextAllowedAt: null,
    };
  }

  const nowMs = now.getTime();
  const local = localFields(nowMs, timeZone);
  const windowText = `${clock(WINDOW_START_HOUR, 0)}-${clock(WINDOW_END_HOUR, 0)}`;

  if (local.hour >= WINDOW_START_HOUR && local.hour < WINDOW_END_HOUR) {
    return { allowed: true, reason: `Within ${windowText} local time in ${timeZone}.`, nextAllowedAt: null };
  }

  return {
    allowed: false,
    reason: `Held: it is ${clock(local.hour, local.minute)} in ${timeZone}, and reminders go out only ${windowText} patient-local time.`,
    nextAllowedAt: holdUntilWindow(nowMs, timeZone),
  };
}
