// Push gate for proactive nudges. Each attempt() asks: may a push go to this user right now?
//
// Rules, checked in this order (first hit wins):
//   1. quiet_hours        The user's local clock time is inside their quiet period.
//                         quietEnd is exclusive, so 07:00 is already allowed.
//   2. daily_cap_reached  The user already got dailyCap pushes on their local calendar day.
//
// "Day" means the user's calendar day in their own IANA zone, not a rolling 24 hours.
// Only allowed pushes are recorded. History lives in memory and is lost on restart.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Any local calendar day starts at most 24h before now. 48h keeps that day and leaves slack.
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      throw new TypeError(`user.timeZone is not a valid IANA zone: ${JSON.stringify(timeZone)}`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Returns the calendar day ("YYYY-MM-DD") and minutes since local midnight for an instant.
function localParts(date, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(value, field) {
  const match = typeof value === "string" ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${field} must be a 24-hour HH:MM string, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function isInQuietHours(minutes, start, end) {
  if (start === end) return false; // Empty window: no quiet period.
  // A window that crosses midnight (e.g. 22:00 to 07:00) wraps around.
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function validate(user, now) {
  if (typeof user !== "object" || user === null) {
    throw new TypeError("user must be an object");
  }
  if (typeof user.id !== "string" || user.id === "") {
    throw new TypeError("user.id must be a non-empty string");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError(`user.dailyCap must be a non-negative integer, got ${JSON.stringify(user.dailyCap)}`);
  }
  // Quiet hours are optional. If one bound is set, both must be.
  const hasStart = user.quietStart != null;
  const hasEnd = user.quietEnd != null;
  if (hasStart || hasEnd) {
    return {
      start: toMinutes(user.quietStart, "user.quietStart"),
      end: toMinutes(user.quietEnd, "user.quietEnd"),
    };
  }
  return null;
}

export function createPushGate() {
  // user.id -> timestamps (ms) of pushes that were allowed.
  const sent = new Map();

  return {
    attempt(user, now) {
      const quiet = validate(user, now);
      formatterFor(user.timeZone); // Throws early on a bad zone, even with no quiet hours set.

      const nowMs = now.getTime();
      const today = localParts(now, user.timeZone);

      if (quiet && isInQuietHours(today.minutes, quiet.start, quiet.end)) {
        return { allowed: false, reason: "quiet_hours" };
      }

      // Drop entries too old to be on today's local day, so memory stays bounded.
      const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < HISTORY_WINDOW_MS);

      const sentToday = history.filter(
        (t) => localParts(new Date(t), user.timeZone).day === today.day,
      ).length;

      if (sentToday >= user.dailyCap) {
        storeOrDelete(sent, user.id, history);
        return { allowed: false, reason: "daily_cap_reached" };
      }

      history.push(nowMs);
      storeOrDelete(sent, user.id, history);
      return { allowed: true, reason: null };
    },
  };
}

function storeOrDelete(sent, id, history) {
  if (history.length === 0) {
    sent.delete(id);
  } else {
    sent.set(id, history);
  }
}
