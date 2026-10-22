// Push gate: quiet hours and a daily cap, both in the user's own time zone.
// History lives in memory only, one independent history per createPushGate().

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP_MS = 48 * 60 * 60 * 1000; // a local day is at most 25 h long

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

// Returns { day: "YYYY-MM-DD", minutes } in the zone, or null for an invalid zone.
function localParts(date, timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  let f;
  try {
    f = formatterFor(timeZone);
  } catch {
    return null;
  }
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === "string" ? HHMM.exec(s.trim()) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start minute is inside the window, end minute is outside. start > end wraps past midnight.
function inQuiet(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sent = new Map(); // user id -> array of epoch ms of pushes allowed

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");
      if (!user || typeof user.id !== "string" || user.id === "") return deny("invalid_user");

      const local = localParts(now, user.timeZone);
      if (!local) return deny("invalid_time_zone");

      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) return deny("invalid_quiet_hours");

      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) return deny("invalid_daily_cap");

      if (inQuiet(local.minutes, start, end)) return deny("quiet_hours");

      const t = now.getTime();
      const history = (sent.get(user.id) ?? []).filter((x) => t - x < KEEP_MS && x - t < KEEP_MS);
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
