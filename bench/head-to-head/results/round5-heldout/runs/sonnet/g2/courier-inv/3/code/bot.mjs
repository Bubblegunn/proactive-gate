// In-memory gate the agent calls right before it sends a push.
// Rules, checked in order: quiet hours, then daily cap. Both use the user's own
// time zone, so "night" and "day" mean the user's local night and local calendar day.

const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const formatters = new Map();

function formatterFor(timeZone) {
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

// Local calendar date (YYYY-MM-DD) and minutes since local midnight.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function parseClock(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof value === "string" ? value : "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Quiet period is [start, end). It wraps past midnight when start > end.
// start === end is an empty period (no quiet hours).
function inQuietPeriod(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> timestamps (ms) of allowed pushes

  return {
    attempt(user, now) {
      const deny = (reason) => ({ allowed: false, reason });

      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");
      if (!user || typeof user.id !== "string" || user.id === "") return deny("invalid_user_settings");

      const start = parseClock(user.quietStart);
      const end = parseClock(user.quietEnd);
      const cap = user.dailyCap;
      if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
        return deny("invalid_user_settings");
      }

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return deny("invalid_time_zone");
      }

      if (inQuietPeriod(local.minutes, start, end)) return deny("quiet_hours");

      const nowMs = now.getTime();
      const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
      const today = history.filter((t) => localParts(new Date(t), user.timeZone).day === local.day);
      if (today.length >= cap) {
        sent.set(user.id, history);
        return deny("daily_cap_reached");
      }

      history.push(nowMs);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
