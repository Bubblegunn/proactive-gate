// Push gate for agent-initiated notifications.
// attempt() is called right before a push. If it returns allowed: true, the
// caller sends the push and that call is counted against the user's day.
// State is in memory: one process, nothing survives a restart.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // history older than this can never count toward a local day

export function createPushGate() {
  const sent = new Map(); // userId -> [ms timestamps of allowed pushes]
  const formatters = new Map(); // IANA zone -> Intl.DateTimeFormat

  // Local calendar day and minute-of-day for an instant in a zone, or null if the zone is invalid.
  function localParts(instant, timeZone) {
    let fmt = formatters.get(timeZone);
    if (!fmt) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return null;
      }
      formatters.set(timeZone, fmt);
    }
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    return {
      day: `${p.year}-${p.month}-${p.day}`,
      minute: Number(p.hour) * 60 + Number(p.minute),
    };
  }

  // "HH:MM" -> minute of day, or null if malformed.
  function parseHHMM(value) {
    const m = typeof value === 'string' ? HHMM.exec(value) : null;
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // Start inclusive, end exclusive. start > end wraps past midnight. start === end is an empty window.
  function inWindow(minute, start, end) {
    if (start === end) return false;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  function prune(list, now) {
    const cutoff = now - KEEP_MS;
    let i = 0;
    while (i < list.length && list[i] < cutoff) i++;
    if (i > 0) list.splice(0, i);
    return list;
  }

  function attempt(user, now) {
    if (!user || typeof user.id !== 'string' || user.id === '') {
      return { allowed: false, reason: 'invalid_user' };
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_time' };
    }

    const local = typeof user.timeZone === 'string' ? localParts(now, user.timeZone) : null;
    if (!local) {
      return { allowed: false, reason: 'invalid_time_zone' };
    }

    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }

    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    if (inWindow(local.minute, start, end)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    const nowMs = now.getTime();
    const history = prune(sent.get(user.id) ?? [], nowMs);
    const sentToday = history.filter((ms) => localParts(new Date(ms), user.timeZone)?.day === local.day).length;
    if (sentToday >= user.dailyCap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push(nowMs);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
