// In-memory push gate for the agent. Decides, per call, whether a push may go
// to a user right now. Nothing is persisted; history lives as long as the gate.
//
// Rules, checked in this order (first match wins, returns its reason code):
//   1. quiet_hours              now falls in the user's quiet window (local time)
//   2. daily_cap_reached        user already got dailyCap pushes on this local calendar day
//   3. too_soon_after_last_push a push went out less than MIN_GAP_MS ago
//
// "Day" and "night" are the user's wall clock in user.timeZone, not UTC and not
// a rolling 24h window. Quiet hours may wrap midnight (22:00 -> 07:00). Start is
// inclusive, end is exclusive. quietStart === quietEnd means no quiet window.

// Apple HIG and Google's notification guidance both push against bursts and
// frequent interruptions. Two pushes a few minutes apart is the "buzzed twice"
// pattern users complain about, so pushes are spaced out even under the cap.
const MIN_GAP_MS = 30 * 60 * 1000;

// Only needs to cover one local day plus a DST shift (max ~25h). 48h is safe.
const RETAIN_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone, which is what we want.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Local calendar day ("2026-10-23") and minutes since local midnight for an instant.
function localClock(date, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseClock(value, field) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof value === 'string' ? value : '');
  if (!match) {
    throw new TypeError(`${field} must be 24-hour HH:MM, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function isQuiet(minutes, start, end) {
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function validateUser(user) {
  if (!user || typeof user.id !== 'string' || user.id === '') {
    throw new TypeError('user.id must be a non-empty string');
  }
  if (typeof user.timeZone !== 'string') {
    throw new TypeError('user.timeZone must be an IANA zone name');
  }
  localClock(new Date(0), user.timeZone); // throws RangeError if the zone is unknown
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError(`user.dailyCap must be an integer >= 0, got ${JSON.stringify(user.dailyCap)}`);
  }
  return {
    start: parseClock(user.quietStart, 'user.quietStart'),
    end: parseClock(user.quietEnd, 'user.quietEnd'),
  };
}

export function createPushGate() {
  // userId -> epoch ms of each push that was allowed
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
      }
      const { start, end } = validateUser(user);
      const t = now.getTime();
      const { day, minutes } = localClock(now, user.timeZone);

      // Absolute-time history, so a timezone change does not lose or duplicate counts.
      // Using Math.abs keeps a clock that steps backwards from blocking pushes for hours.
      const history = (sent.get(user.id) ?? []).filter((ts) => Math.abs(t - ts) < RETAIN_MS);

      const deny = (reason) => ({ allowed: false, reason });

      if (isQuiet(minutes, start, end)) return deny('quiet_hours');

      const sentToday = history.filter(
        (ts) => localClock(new Date(ts), user.timeZone).day === day,
      ).length;
      if (sentToday >= user.dailyCap) return deny('daily_cap_reached');

      if (history.some((ts) => Math.abs(t - ts) < MIN_GAP_MS)) {
        return deny('too_soon_after_last_push');
      }

      // Only allowed pushes are recorded. The caller sends right after a true result.
      history.push(t);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
