// Push gate: decides whether a push may go to a user now. It never sends anything.
// History is kept in memory only; each createPushGate() call has its own history.

const HOUR_MS = 60 * 60 * 1000;
// Longest span a local day can reach back from "now": UTC offsets reach +-14h, so 48h is safe.
const KEEP_MS = 48 * HOUR_MS;

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

// Returns { day: "YYYY-MM-DD", minute: minutes since local midnight } in the given zone.
function localParts(date, timeZone) {
  const p = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) p[part.type] = part.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of send times (ms since epoch)

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_now' };
    }
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }

    // Unknown or invalid settings mean hold, never a guess.
    let local;
    try {
      if (typeof user.timeZone !== 'string' || user.timeZone === '') throw new RangeError('zone');
      local = localParts(now, user.timeZone);
    } catch {
      return { allowed: false, reason: 'invalid_time_zone' };
    }
    const start = parseClock(user.quietStart);
    const end = parseClock(user.quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }
    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    // Quiet period: start minute included, end minute excluded, wraps past midnight
    // when start > end. start === end is an empty period.
    const m = local.minute;
    const quiet = start <= end ? m >= start && m < end : m >= start || m < end;
    if (quiet) return { allowed: false, reason: 'quiet_hours' };

    // Daily cap counts pushes in the user's own local calendar day.
    const t = now.getTime();
    const history = (sent.get(user.id) ?? []).filter((x) => x > t - KEEP_MS);
    let today = 0;
    for (const x of history) {
      if (localParts(new Date(x), user.timeZone).day === local.day) today++;
    }
    if (today >= cap) {
      sent.set(user.id, history);
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push(t);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
