// In-memory gate for agent-initiated push notifications.
// Rules, in order: valid input, quiet hours (user's local time), daily cap (user's local day).

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // local day is at most 14h off UTC, so 3 days covers any "today"

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
    formatters.set(timeZone, fmt); // throws RangeError on an invalid zone, so it is not cached
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === 'string' ? HH_MM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start minute included, end minute excluded; start > end wraps past midnight; start === end is empty.
function inQuiet(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> timestamps (ms) of pushes allowed

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_time' };
    }
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }

    // Unknown or invalid settings are held, never guessed.
    let local;
    try {
      if (typeof user.timeZone !== 'string' || user.timeZone === '') throw new RangeError('no zone');
      local = localParts(user.timeZone, now);
    } catch {
      return { allowed: false, reason: 'invalid_time_zone' };
    }
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (start === null || end === null) return { allowed: false, reason: 'invalid_quiet_hours' };
    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) return { allowed: false, reason: 'invalid_daily_cap' };

    if (inQuiet(local.minutes, start, end)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    const nowMs = now.getTime();
    const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
    const today = history.filter((t) => localParts(user.timeZone, new Date(t)).day === local.day);
    if (today.length >= cap) {
      sent.set(user.id, history);
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push(nowMs);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
