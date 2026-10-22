// Push gate for the proactive agent. Call attempt() right before sending a push.
// History is kept in memory only; nothing survives a restart (by design).
//
// Rules, checked in this order:
//   quiet_hours        - `now` falls in the user's quiet window (their local clock).
//   daily_cap_reached  - the user already got dailyCap pushes on their local calendar day.
//   min_gap            - the previous push to this user was less than MIN_GAP_MS ago.

const MIN_GAP_MS = 60 * 60 * 1000; // at least 1 hour between pushes to one user
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // older history is dropped; covers any local day plus tz offsets

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const formatters = new Map();

// Wall-clock parts of `date` in `timeZone`. hourCycle h23 avoids a "24" midnight.
function localParts(timeZone, date) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}

function localDayKey(timeZone, ms) {
  const p = localParts(timeZone, new Date(ms));
  return `${p.year}-${p.month}-${p.day}`;
}

function localMinutes(timeZone, ms) {
  const p = localParts(timeZone, new Date(ms));
  return Number(p.hour) * 60 + Number(p.minute);
}

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Quiet window [start, end) in minutes. A window whose end is before its start
// runs past midnight (22:00-07:00). Equal start and end means no window.
function inQuietWindow(minute, startHHMM, endHHMM) {
  if (startHHMM == null || endHHMM == null) return false;
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function assertInput(user, now) {
  if (!user || typeof user.id !== 'string' || user.id === '') {
    throw new TypeError('user.id must be a non-empty string');
  }
  if (typeof user.timeZone !== 'string') {
    throw new TypeError('user.timeZone must be an IANA zone name');
  }
  // Throws RangeError for an unknown zone.
  localParts(user.timeZone, new Date(0));
  for (const key of ['quietStart', 'quietEnd']) {
    const v = user[key];
    if (v != null && !HHMM.test(v)) {
      throw new TypeError(`user.${key} must be HH:MM (24-hour) or null`);
    }
  }
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError('user.dailyCap must be an integer >= 0');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

export function createPushGate() {
  // userId -> epoch ms of pushes that were allowed
  const sent = new Map();

  return {
    attempt(user, now) {
      assertInput(user, now);
      const t = now.getTime();
      const tz = user.timeZone;

      const history = (sent.get(user.id) ?? []).filter((ts) => t - ts <= KEEP_MS);
      sent.set(user.id, history);

      if (inQuietWindow(localMinutes(tz, t), user.quietStart, user.quietEnd)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const today = localDayKey(tz, t);
      const sentToday = history.filter((ts) => localDayKey(tz, ts) === today).length;
      if (sentToday >= user.dailyCap) {
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      if (history.some((ts) => Math.abs(t - ts) < MIN_GAP_MS)) {
        return { allowed: false, reason: 'min_gap' };
      }

      history.push(t);
      return { allowed: true, reason: null };
    },
  };
}
