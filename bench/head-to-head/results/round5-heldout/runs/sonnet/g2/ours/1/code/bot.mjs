// Push gate: decides whether the agent may send a push now. It never sends anything.
// History is in memory only; each createPushGate() call has its own history.

const formatters = new Map();

function localParts(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

function validZone(tz) {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    localParts(new Date(0), tz);
    return true;
  } catch {
    formatters.delete(tz);
    return false;
  }
}

function parseHHMM(s) {
  const m = typeof s === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  // user id -> timestamps (ms) of pushes allowed so far
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!user || typeof user.id !== "string" || user.id === "") return deny("invalid_user");
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");
      // Unknown or invalid settings are held, never guessed.
      if (!validZone(user.timeZone)) return deny("invalid_time_zone");
      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) return deny("invalid_quiet_hours");
      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) return deny("invalid_daily_cap");

      const { day, minute } = localParts(now, user.timeZone);

      // Quiet window includes its start minute, excludes its end minute.
      // start > end wraps past midnight; start == end is an empty window.
      const quiet =
        start < end ? minute >= start && minute < end : start > end && (minute >= start || minute < end);
      if (quiet) return deny("quiet_hours");

      // "Day" is the user's own calendar day in the zone passed in this call.
      const history = sent.get(user.id) ?? [];
      let today = 0;
      for (const t of history) if (localParts(new Date(t), user.timeZone).day === day) today++;
      if (today >= cap) return deny("daily_cap_reached");

      history.push(now.getTime());
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
