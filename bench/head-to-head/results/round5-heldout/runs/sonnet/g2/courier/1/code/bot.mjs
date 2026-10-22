// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order:
//   1. quiet hours  - evaluated in the user's own time zone, window may cross midnight.
//                     Start is inclusive, end is exclusive. start === end means no quiet hours.
//   2. daily cap    - "day" is the user's local calendar day (midnight to midnight in their
//                     time zone), not a UTC day and not a rolling 24 hours.
// Invalid input is refused (fail closed) with its own reason code, because a bad time zone or
// bad quiet-hours string would otherwise risk waking someone up.
// An allowed call is recorded as a sent push. A refused call is never recorded.

const HISTORY_KEEP_MS = 72 * 60 * 60 * 1000; // longer than any local-day / time-zone offset difference
const HHMM = /^(\d{2}):(\d{2})$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone.
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

// Returns { day: "YYYY-MM-DD", minutes: minutes since local midnight } for an instant in a zone.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(value) {
  if (typeof value !== "string") return null;
  const m = HHMM.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return (h * 60 + min) % 1440; // "24:00" means midnight
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // crosses midnight
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sentByUser = new Map(); // user id -> array of epoch ms of pushes allowed

  function attempt(user, now) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id === "") {
      return deny("invalid_user");
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_time");

    const { id, timeZone, quietStart, quietEnd, dailyCap } = user;

    if (!Number.isInteger(dailyCap) || dailyCap < 0) return deny("invalid_daily_cap");
    const start = parseHHMM(quietStart);
    const end = parseHHMM(quietEnd);
    if (start === null || end === null) return deny("invalid_quiet_hours");

    let local;
    try {
      if (typeof timeZone !== "string" || timeZone === "") return deny("invalid_time_zone");
      local = localParts(now, timeZone);
    } catch {
      return deny("invalid_time_zone");
    }

    if (inQuietHours(local.minutes, start, end)) return deny("quiet_hours");

    const nowMs = now.getTime();
    // Drop old history, then count pushes that fall on the same local day as `now`
    // using the zone passed in this call.
    const history = (sentByUser.get(id) ?? []).filter((t) => t > nowMs - HISTORY_KEEP_MS);
    const sentToday = history.filter((t) => localParts(new Date(t), timeZone).day === local.day).length;

    if (sentToday >= dailyCap) {
      sentByUser.set(id, history);
      return deny("daily_cap_reached");
    }

    history.push(nowMs);
    sentByUser.set(id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
