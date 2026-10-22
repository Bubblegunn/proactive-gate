// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order:
//   1. Quiet hours, read on the user's own wall clock (their IANA time zone).
//      The window is [quietStart, quietEnd): a push at exactly quietEnd is allowed.
//      It may wrap midnight (22:00-07:00). If quietStart equals quietEnd the
//      user has no quiet period.
//   2. Daily cap, counted per local calendar day of the user (midnight to
//      midnight in their time zone), not a rolling 24 hours and not UTC.
//
// Only allowed attempts count toward the cap. Blocked attempts do not.
// Bad input is refused (fail closed) with its own reason code.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP_DAYS = 3; // local days of history kept per user (covers time zone changes)

const formatters = new Map();

function localParts(timeZone, date) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, fmt); // throws RangeError for an unknown zone, before caching
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseTime(s) {
  const m = typeof s === 'string' ? TIME_RE.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuiet(minutes, start, end) {
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // wraps midnight
}

export function createPushGate() {
  // userId -> Map(local day "YYYY-MM-DD" -> pushes allowed that day)
  const history = new Map();

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return { allowed: false, reason: 'invalid_time' };
      }
      if (!user || typeof user.id !== 'string' || user.id === '') {
        return { allowed: false, reason: 'invalid_user' };
      }
      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) {
        return { allowed: false, reason: 'invalid_daily_cap' };
      }
      const start = parseTime(user.quietStart);
      const end = parseTime(user.quietEnd);
      if (start === null || end === null) {
        return { allowed: false, reason: 'invalid_quiet_hours' };
      }
      let local;
      try {
        local = localParts(user.timeZone, now);
      } catch {
        return { allowed: false, reason: 'invalid_time_zone' };
      }

      if (inQuiet(local.minutes, start, end)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      let days = history.get(user.id);
      if (!days) {
        days = new Map();
        history.set(user.id, days);
      }
      const sent = days.get(local.day) ?? 0;
      if (sent >= cap) {
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      days.set(local.day, sent + 1);
      if (days.size > KEEP_DAYS) {
        const oldest = [...days.keys()].sort().slice(0, days.size - KEEP_DAYS);
        for (const k of oldest) days.delete(k);
      }
      return { allowed: true, reason: null };
    },
  };
}
