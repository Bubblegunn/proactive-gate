// Push gate for the meal-planning agent.
// attempt(user, now) runs just before a push. Only allowed:true counts as a push sent,
// so the caller must send right away when it gets allowed:true.
// History is in memory: one createPushGate() call = one independent gate.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function isValidZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Local calendar day (YYYY-MM-DD) and minute of day (0-1439) in the user's zone.
function localParts(timeZone, now) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(now)) parts[p.type] = p.value;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm) {
  const m = typeof hhmm === 'string' ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start minute is inside, end minute is outside. start > end wraps past midnight.
// start === end means no quiet period.
function inQuietHours(minute, start, end) {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function createPushGate() {
  // userId -> Map(local dateKey -> pushes allowed that day)
  const sent = new Map();

  function attempt(user, now) {
    if (!user || typeof user !== 'object' || user.id == null) {
      return { allowed: false, reason: 'invalid_user' };
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: 'invalid_now' };
    }
    const { id, timeZone, quietStart, quietEnd, dailyCap } = user;
    if (!isValidZone(timeZone)) {
      return { allowed: false, reason: 'unknown_time_zone' };
    }
    const start = toMinutes(quietStart);
    const end = toMinutes(quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: 'invalid_quiet_hours' };
    }
    if (!Number.isInteger(dailyCap) || dailyCap < 0) {
      return { allowed: false, reason: 'invalid_daily_cap' };
    }

    const { dateKey, minute } = localParts(timeZone, now);
    if (inQuietHours(minute, start, end)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    let days = sent.get(id);
    if (!days) {
      days = new Map();
      sent.set(id, days);
    }
    const count = days.get(dateKey) ?? 0;
    if (count >= dailyCap) {
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    // Drop earlier local days so memory does not grow without bound.
    for (const key of days.keys()) {
      if (key < dateKey) days.delete(key);
    }
    days.set(dateKey, count + 1);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
