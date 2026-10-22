// Push gate: decides whether the agent may send one push to one user right now.
//
// Rules, checked in this order (first match wins, reason = its code):
//   quiet_hours        now is inside the user's quiet period, in the user's local time.
//   daily_cap_reached  the user already received dailyCap pushes on their local calendar day.
//   too_soon           the previous push to this user was less than MIN_GAP_MS ago.
//
// "Day" and "night" are the user's local clock, not UTC and not the server's clock.
// Quiet hours may wrap past midnight (22:00 -> 07:00). Equal start and end means no quiet period.
// The daily cap resets at the user's local midnight.
// The minimum gap keeps several nudges from landing in a burst, which Apple's and Google's
// notification guidance both warn against (avoid excessive, repeated interruptions).
//
// Only allowed attempts are recorded, because only those become pushes.
// History is kept in memory and pruned to the last 48 hours, which is more than
// any user's local day can span.

const MIN_GAP_MS = 60 * 60 * 1000;
const HISTORY_MS = 48 * 60 * 60 * 1000;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

// Returns the local calendar day ("YYYY-MM-DD") and minute of day (0..1439) for a
// timestamp in the given IANA zone. Throws RangeError for an unknown zone.
function localClock(ms, timeZone) {
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
    formatters.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(ms)) parts[p.type] = p.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHhMm(value, name) {
  const m = typeof value === 'string' && HH_MM.exec(value);
  if (!m) throw new TypeError(`${name} must be "HH:MM" 24-hour, got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function inQuietHours(minute, start, end) {
  if (start === end) return false;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

export function createPushGate() {
  // userId -> array of epoch ms of pushes that were allowed
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!user || user.id == null) throw new TypeError('user.id is required');
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
      }
      if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
        throw new TypeError('user.dailyCap must be an integer >= 0');
      }
      const quietStart = parseHhMm(user.quietStart, 'user.quietStart');
      const quietEnd = parseHhMm(user.quietEnd, 'user.quietEnd');

      const nowMs = now.getTime();
      const clock = localClock(nowMs, user.timeZone);

      if (inQuietHours(clock.minute, quietStart, quietEnd)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const history = (sent.get(user.id) ?? []).filter((ts) => ts > nowMs - HISTORY_MS);

      const todayCount = history.filter(
        (ts) => localClock(ts, user.timeZone).day === clock.day,
      ).length;
      if (todayCount >= user.dailyCap) {
        sent.set(user.id, history);
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      const last = history.length ? Math.max(...history) : null;
      if (last !== null && nowMs - last < MIN_GAP_MS) {
        sent.set(user.id, history);
        return { allowed: false, reason: 'too_soon' };
      }

      history.push(nowMs);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
