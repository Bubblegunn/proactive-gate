// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order (first match wins):
//   invalid_time             `now` is not a valid Date
//   invalid_user_settings    id, timeZone, quiet hours or dailyCap cannot be used (fail closed)
//   quiet_hours              the user's local clock is inside quietStart..quietEnd
//   daily_cap_reached        the user already got dailyCap pushes this local calendar day
//
// "Day" is the calendar day in the user's own time zone (midnight to midnight local),
// not a rolling 24 hours and not UTC. "Night" is the user's own quiet window in their
// own zone; it may cross midnight. Start is inclusive, end is exclusive.
// quietStart === quietEnd means the user has no quiet window.
// Blocked attempts are not counted. Only allowed attempts are recorded as sent.
// Settings are read from each call, so a changed time zone or cap applies immediately.

const HISTORY_KEEP_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

function getFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar date key and minutes since local midnight, in the given zone.
function localParts(date, timeZone) {
  const parts = {};
  for (const p of getFormatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseClock(value) {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // crosses midnight
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of Date.getTime() of allowed pushes

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return { allowed: false, reason: "invalid_time" };
      }
      const invalid = { allowed: false, reason: "invalid_user_settings" };
      if (!user || typeof user !== "object" || user.id == null || user.id === "") return invalid;

      const start = parseClock(user.quietStart);
      const end = parseClock(user.quietEnd);
      const cap = user.dailyCap;
      if (start === null || end === null) return invalid;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return invalid;
      if (typeof user.timeZone !== "string" || user.timeZone === "") return invalid;

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return invalid; // unknown IANA zone
      }

      if (inQuietWindow(local.minutes, start, end)) {
        return { allowed: false, reason: "quiet_hours" };
      }

      const nowMs = now.getTime();
      const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < HISTORY_KEEP_MS);
      const today = history.filter((t) => localParts(new Date(t), user.timeZone).dayKey === local.dayKey);
      if (today.length >= Math.floor(cap)) {
        sent.set(user.id, history);
        return { allowed: false, reason: "daily_cap_reached" };
      }

      history.push(nowMs);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
