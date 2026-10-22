// Push gate for the meal-planning agent.
//
// Called right before the agent sends a push. Returns allowed: true only when
// the push may go out now, and in that case the call counts as a sent push.
//
// Rules, checked in this order:
//   1. quiet_hours: the user's local clock is inside their quiet period.
//      The gate cannot delay a send (the caller sends at once when allowed),
//      so a push in quiet hours is dropped, not queued.
//   2. daily_cap_reached: the user already received dailyCap pushes on their
//      local calendar day (midnight to midnight in user.timeZone).
//
// Blocked attempts are not counted. History is kept in memory only.

const REASON_QUIET_HOURS = 'quiet_hours';
const REASON_DAILY_CAP = 'daily_cap_reached';

// Longer than any local day (zones span UTC-12 to UTC+14), so every push
// that could share today's local date is still kept.
const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

function localParts(instant, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    parts[type] = value;
  }
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm, field) {
  const match = typeof hhmm === 'string' && HH_MM.exec(hhmm);
  if (!match) {
    throw new TypeError(`${field} must be an HH:MM 24-hour string, got ${JSON.stringify(hhmm)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// The quiet period runs from quietStart up to quietEnd. When start is later
// than end (for example 22:00 to 07:00) it wraps past midnight. Equal start
// and end means no quiet period.
function isQuiet(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  // userId -> epoch ms of each push that was allowed
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!user || typeof user.id !== 'string' || user.id === '') {
        throw new TypeError('user.id must be a non-empty string');
      }
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
      }
      if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
        throw new TypeError(`user.dailyCap must be a non-negative integer, got ${user.dailyCap}`);
      }

      const start = toMinutes(user.quietStart, 'user.quietStart');
      const end = toMinutes(user.quietEnd, 'user.quietEnd');
      const { dayKey, minutes } = localParts(now, user.timeZone);

      if (isQuiet(minutes, start, end)) {
        return { allowed: false, reason: REASON_QUIET_HOURS };
      }

      const nowMs = now.getTime();
      const history = (sent.get(user.id) ?? []).filter(
        (t) => t > nowMs - HISTORY_WINDOW_MS,
      );

      const sentToday = history.filter(
        (t) => localParts(new Date(t), user.timeZone).dayKey === dayKey,
      ).length;
      if (sentToday >= user.dailyCap) {
        sent.set(user.id, history);
        return { allowed: false, reason: REASON_DAILY_CAP };
      }

      history.push(nowMs);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
