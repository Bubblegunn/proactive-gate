// Push gate for the meal-planning agent.
// attempt() decides whether one push may go to one user now. It sends nothing.
// If it returns allowed: true, the caller must send that push, because the call
// has already counted it against the user's daily cap.
// State lives in memory only, so a restart clears it (accepted by the owner).

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

// Local calendar date ("YYYY-MM-DD") and minute of day (0-1439) for `now` in `timeZone`.
// Throws RangeError when the zone is not a valid IANA name.
function localParts(now, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(value) {
  const m = typeof value === 'string' ? HHMM.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// start == end means no quiet period. start > end wraps past midnight.
// The start minute is inside the window, the end minute is outside.
function inQuiet(minute, start, end) {
  if (start === end) return false;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

// Date key for the day before "YYYY-MM-DD", computed in UTC so no zone applies.
function previousDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function createPushGate() {
  // userId -> Map(local date key -> pushes allowed that day)
  const sentByUser = new Map();

  function deny(reason) {
    return { allowed: false, reason };
  }

  return {
    attempt(user, now) {
      if (!user || typeof user.id !== 'string' || user.id === '') {
        return deny('invalid_user');
      }
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return deny('invalid_time');
      }

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return deny('invalid_time_zone');
      }

      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) {
        return deny('invalid_quiet_hours');
      }
      if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
        return deny('invalid_daily_cap');
      }

      if (inQuiet(local.minute, start, end)) {
        return deny('quiet_hours');
      }

      let days = sentByUser.get(user.id);
      if (!days) {
        days = new Map();
        sentByUser.set(user.id, days);
      }
      // Keep today and yesterday. The zone can change between calls, so a
      // one-day overlap keeps the count right.
      const cutoff = previousDay(local.date);
      for (const key of days.keys()) {
        if (key < cutoff) days.delete(key);
      }

      const sent = days.get(local.date) ?? 0;
      if (sent >= user.dailyCap) {
        return deny('daily_cap_reached');
      }

      days.set(local.date, sent + 1);
      return { allowed: true, reason: null };
    },
  };
}
