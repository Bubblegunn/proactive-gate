// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order:
//   1. quiet hours, in the user's own time zone (can span midnight)
//   2. daily cap, counted per calendar day in the user's own time zone
// A blocked attempt is never counted. An allowed attempt counts as sent.

const HISTORY_KEEP_MS = 3 * 24 * 60 * 60 * 1000; // longer than any local day

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
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

// Returns { day: "YYYY-MM-DD", minutes } in the given zone. Throws on a bad zone.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false; // empty window: quiet hours switched off
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // spans midnight
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sent = new Map(); // user id -> array of send times (ms)

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");
      if (!user || typeof user.id !== "string" || user.id === "") return deny("invalid_settings");

      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      const cap = user.dailyCap;
      if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
        return deny("invalid_settings");
      }

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return deny("invalid_settings"); // unknown time zone: fail closed
      }

      if (inQuietHours(local.minutes, start, end)) return deny("quiet_hours");

      const t = now.getTime();
      const history = (sent.get(user.id) ?? []).filter((x) => Math.abs(t - x) < HISTORY_KEEP_MS);
      const today = history.filter((x) => localParts(new Date(x), user.timeZone).day === local.day);

      if (today.length >= cap) {
        sent.set(user.id, history);
        return deny("daily_cap_reached");
      }

      history.push(t);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
