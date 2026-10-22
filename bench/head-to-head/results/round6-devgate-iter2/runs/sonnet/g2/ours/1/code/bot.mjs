// Push gate: decides whether the agent may send one push to a user right now.
// It never sends anything. History lives in memory, one gate per createPushGate() call.

const HISTORY_MS = 3 * 24 * 60 * 60 * 1000; // enough to cover any zone change within a local day

const formatters = new Map();

// Returns an Intl formatter for the zone, or null when the zone is missing or invalid.
function formatterFor(timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    fmt = null;
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

// Local calendar day (YYYY-MM-DD) and minutes since local midnight.
function localParts(fmt, date) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start is included, end is excluded. A start later than the end wraps past midnight.
// Equal start and end is an empty window (no quiet hours).
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of ms timestamps of allowed pushes

  const refuse = (reason) => ({ allowed: false, reason });

  return {
    attempt(user, now) {
      const at = now instanceof Date ? now.getTime() : NaN;
      if (Number.isNaN(at)) return refuse("invalid_time");
      if (!user || typeof user.id !== "string" || user.id === "") return refuse("invalid_user");

      // Unknown or invalid settings are held, never guessed.
      const fmt = formatterFor(user.timeZone);
      if (!fmt) return refuse("invalid_time_zone");
      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) return refuse("invalid_quiet_hours");
      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) return refuse("invalid_daily_cap");

      const local = localParts(fmt, now);

      if (inQuietWindow(local.minutes, start, end)) return refuse("quiet_hours");

      const history = (sent.get(user.id) ?? []).filter((t) => at - t < HISTORY_MS);
      const today = history.filter((t) => localParts(fmt, new Date(t)).day === local.day).length;
      if (today >= cap) {
        sent.set(user.id, history);
        return refuse("daily_cap_reached");
      }

      history.push(at);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
