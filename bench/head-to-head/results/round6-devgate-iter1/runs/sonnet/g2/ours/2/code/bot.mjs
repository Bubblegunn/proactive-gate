// In-memory push gate. Decides only; never sends.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(s) {
  const m = typeof s === "string" ? HHMM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const formatters = new Map();

// Local calendar day ("YYYY-MM-DD") and minute of day in the given IANA zone.
// Returns null when the zone is not valid.
function localTime(timeZone, now) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return null;
    }
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(now)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

// Start minute is inside the window, end minute is outside. Start > end wraps midnight.
// Start == end is an empty window.
function inQuiet(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> { day, count } for the user's current local day

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: "invalid_time" };
    }
    if (!user || typeof user.id !== "string" || user.id === "") {
      return { allowed: false, reason: "invalid_user" };
    }
    const start = toMinutes(user.quietStart);
    const end = toMinutes(user.quietEnd);
    const cap = user.dailyCap;
    if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: "invalid_settings" };
    }
    const local = localTime(user.timeZone, now);
    if (!local) return { allowed: false, reason: "invalid_time_zone" };

    if (inQuiet(local.minute, start, end)) {
      return { allowed: false, reason: "quiet_hours" };
    }

    let rec = sent.get(user.id);
    if (!rec || rec.day !== local.day) rec = { day: local.day, count: 0 };
    if (rec.count >= cap) {
      sent.set(user.id, rec);
      return { allowed: false, reason: "daily_cap_reached" };
    }
    rec.count += 1;
    sent.set(user.id, rec);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
