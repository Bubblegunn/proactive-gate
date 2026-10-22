// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order:
//   1. invalid input            -> blocked (fail closed, never wake someone on bad data)
//   2. user's quiet hours       -> quiet_hours
//   3. user's daily cap         -> daily_cap_reached
// "Day" is the calendar day (midnight to midnight) in the user's own time zone,
// not a rolling 24 hours. "Night" is the user's quiet window in that same zone.
// Only allowed attempts are recorded; blocked attempts do not use up the cap.

const HISTORY_TTL_MS = 72 * 3600 * 1000; // longer than any calendar day + zone change
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar date ("YYYY-MM-DD") and minutes since local midnight.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === 'string' ? HHMM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Equal start and end means the user has no quiet period.
function inQuiet(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // runs past midnight
}

export function createPushGate() {
  const sent = new Map(); // user id -> ascending array of send times (ms)

  function check(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return 'invalid_time';
    if (!user || typeof user !== 'object' || typeof user.id !== 'string' || user.id === '') {
      return 'invalid_user';
    }
    const { timeZone, dailyCap } = user;
    if (typeof timeZone !== 'string' || timeZone === '') return 'invalid_time_zone';
    try {
      formatterFor(timeZone);
    } catch {
      return 'invalid_time_zone';
    }
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (start === null || end === null) return 'invalid_quiet_hours';
    if (!Number.isInteger(dailyCap) || dailyCap < 0) return 'invalid_daily_cap';

    const here = localParts(now, timeZone);
    if (inQuiet(here.minutes, start, end)) return 'quiet_hours';

    const times = sent.get(user.id) ?? [];
    let today = 0;
    for (const t of times) if (localParts(new Date(t), timeZone).day === here.day) today++;
    if (today >= dailyCap) return 'daily_cap_reached';
    return null;
  }

  return {
    attempt(user, now) {
      const reason = check(user, now);
      if (reason !== null) return { allowed: false, reason };

      const t = now.getTime();
      const times = (sent.get(user.id) ?? []).filter((x) => t - x < HISTORY_TTL_MS);
      times.push(t);
      sent.set(user.id, times);
      return { allowed: true, reason: null };
    },
  };
}
