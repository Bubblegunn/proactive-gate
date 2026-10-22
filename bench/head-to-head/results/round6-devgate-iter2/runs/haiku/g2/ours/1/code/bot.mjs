// Per-user push gate for the agent. Call attempt() right before a push.
// If it returns allowed: true, the caller must send the push, because that call
// is counted against the user's daily cap.
// History is kept in memory for this process only.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Local clock and calendar date for an instant in an IANA zone.
// Throws RangeError for an invalid zone.
function localParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value;
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function createPushGate() {
  // userId -> [{ dateKey, at }] for pushes that were allowed.
  const sent = new Map();
  const KEEP_MS = 3 * 24 * 60 * 60 * 1000;

  function attempt(user, now) {
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_time' };
    }

    // Local time comes from the user's zone. An unknown zone is held, not guessed.
    let local;
    try {
      local = localParts(now, user.timeZone);
    } catch {
      return { allowed: false, reason: 'invalid_time_zone' };
    }

    // Quiet hours: start inclusive, end exclusive, wraps past midnight when start > end.
    // start === end means no quiet period.
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }
    const m = local.minutes;
    const inQuiet =
      start === end ? false : start < end ? m >= start && m < end : m >= start || m < end;
    if (inQuiet) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    // Daily cap counts pushes on the user's own local calendar day.
    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    const history = (sent.get(user.id) ?? []).filter(
      (e) => now.getTime() - e.at < KEEP_MS && e.at - now.getTime() < KEEP_MS,
    );
    sent.set(user.id, history);

    let todayCount = 0;
    for (const e of history) {
      if (e.dateKey === local.dateKey) todayCount += 1;
    }
    if (todayCount >= cap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push({ dateKey: local.dateKey, at: now.getTime() });
    return { allowed: true, reason: null };
  }

  return { attempt };
}
