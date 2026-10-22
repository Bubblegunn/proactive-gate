// Gate for appointment-reminder SMS. The scheduler calls checkSms(user, now)
// before handing a text to the SMS vendor. This function only decides; it
// never sends anything, reads no files and makes no network calls.

// Texts may go out only between these local times (recipient's own clock).
// A window includes its start minute and excludes its end minute.
const WINDOW_START_MIN = 8 * 60; // 08:00 local, included
const WINDOW_END_MIN = 21 * 60; // 21:00 local, excluded

// How far ahead to look for the next allowed minute. A full day is enough
// for any zone; the bound only stops a loop if something is odd.
const SEARCH_LIMIT_MIN = 48 * 60;

const MINUTE_MS = 60 * 1000;

// Returns the local minute-of-day (0..1439) for an instant in a zone,
// or null when the zone is not a valid IANA name.
function localMinuteOfDay(instant, formatter) {
  const parts = formatter.formatToParts(instant);
  let hour = null;
  let minute = null;
  for (const p of parts) {
    if (p.type === "hour") hour = Number(p.value);
    if (p.type === "minute") minute = Number(p.value);
  }
  if (hour === null || minute === null || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function formatLocalHHMM(minuteOfDay) {
  const h = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const m = String(minuteOfDay % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function inWindow(minuteOfDay) {
  return minuteOfDay >= WINDOW_START_MIN && minuteOfDay < WINDOW_END_MIN;
}

function hold(reason, nextAllowedAt = null) {
  return { allowed: false, reason, nextAllowedAt };
}

export function checkSms(user, now) {
  if (!user || typeof user !== "object") {
    return hold("Not sent: the patient record is missing, so no text can be checked.");
  }

  if (typeof user.phone !== "string" || user.phone.trim() === "") {
    return hold("Not sent: this patient has no phone number on file.");
  }

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return hold("Not sent: the current time was not provided as a valid Date.");
  }

  // Unknown or missing zone: we cannot tell the patient's local time, so we
  // hold and do not guess a zone. There is no time we can predict for it.
  let formatter = null;
  if (typeof user.timezone === "string" && user.timezone.trim() !== "") {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: user.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      formatter = null;
    }
  }
  if (formatter === null) {
    return hold(
      "Not sent: the patient's time zone is missing or not recognised, so the texting window cannot be checked. Set a valid time zone to send.",
    );
  }

  const zone = user.timezone;
  const nowMinute = localMinuteOfDay(now, formatter);
  if (nowMinute === null) {
    return hold(
      "Not sent: the patient's time zone could not be read, so the texting window cannot be checked.",
    );
  }

  if (inWindow(nowMinute)) {
    return { allowed: true, reason: `Allowed: it is ${formatLocalHHMM(nowMinute)} in ${zone}, inside the 08:00 to 21:00 texting window.`, nextAllowedAt: null };
  }

  // Held by quiet hours. Walk forward minute by minute from the next whole
  // minute until the local clock enters the window. Stepping by real minutes
  // keeps DST changes and half-hour offsets correct.
  const floored = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  let nextAllowedAt = null;
  for (let i = 1; i <= SEARCH_LIMIT_MIN; i++) {
    const candidate = new Date(floored + i * MINUTE_MS);
    const m = localMinuteOfDay(candidate, formatter);
    if (m !== null && inWindow(m)) {
      nextAllowedAt = candidate;
      break;
    }
  }

  const retry = nextAllowedAt
    ? ` Earliest retry: ${nextAllowedAt.toISOString()}.`
    : " No retry time could be determined.";

  return hold(
    `Not sent: it is ${formatLocalHHMM(nowMinute)} in ${zone}, and texts go out only between 08:00 and 21:00 local time.${retry}`,
    nextAllowedAt,
  );
}
