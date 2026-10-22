// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order (each has its own reason code):
//   invalid_*          settings or clock cannot be trusted, so nothing is sent
//   quiet_hours        user's local time is inside quietStart..quietEnd
//   daily_cap_reached  user already got dailyCap pushes on their local calendar day
//
// "Day" and "night" are the user's own: the IANA time zone from the device
// decides both the local clock for quiet hours and where the day starts and ends.

const KEEP_MS = 48 * 60 * 60 * 1000; // longer than any local day can span a UTC offset change

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

// Returns { dayKey: "YYYY-MM-DD", minutes: minutes since local midnight } or null for a bad zone.
function localTime(date, timeZone) {
  let f;
  try {
    f = formatterFor(timeZone);
  } catch {
    return null;
  }
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietPeriod(minutes, start, end) {
  if (start === end) return false; // empty period: user has no quiet hours
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // runs past midnight
}

export function createPushGate() {
  const sent = new Map(); // user id -> timestamps (ms) of pushes allowed

  function deny(reason) {
    return { allowed: false, reason };
  }

  function attempt(user, now) {
    if (!user || typeof user.id !== "string" || user.id === "") return deny("invalid_user");
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");
    if (typeof user.timeZone !== "string") return deny("invalid_time_zone");
    const local = localTime(now, user.timeZone);
    if (!local) return deny("invalid_time_zone");
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (start === null || end === null) return deny("invalid_quiet_hours");
    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) return deny("invalid_daily_cap");

    if (inQuietPeriod(local.minutes, start, end)) return deny("quiet_hours");

    const nowMs = now.getTime();
    // Drop history older than any local day can reach.
    const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
    const today = history.filter((t) => localTime(new Date(t), user.timeZone).dayKey === local.dayKey);
    if (today.length >= user.dailyCap) {
      sent.set(user.id, history);
      return deny("daily_cap_reached");
    }

    history.push(nowMs);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
