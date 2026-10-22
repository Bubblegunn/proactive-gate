// Per-user push gate for the meal-planning agent.
// History lives in memory only; a restart clears it.
//
// Two rules, both evaluated in the user's own timezone:
//   1. Quiet hours: no push while the user's local clock is inside the
//      quiet window (start inclusive, end exclusive, may cross midnight).
//   2. Daily cap: at most `dailyCap` allowed pushes per user-local calendar day.

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const formatters = new Map();

// Local calendar date (YYYY-MM-DD) and minute-of-day for an instant in a zone.
function localParts(timeZone, ms) {
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
  const parts = {};
  for (const { type, value } of fmt.formatToParts(ms)) parts[type] = value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new TypeError(`Expected HH:MM, got ${JSON.stringify(hhmm)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function inQuietHours(minutes, quietStart, quietEnd) {
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  if (start === end) return false; // empty window: quiet hours effectively off
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // window runs past midnight
}

export function createPushGate() {
  const sent = new Map(); // user.id -> epoch ms of each push that was allowed

  return {
    attempt(user, now) {
      const nowMs = now.getTime();
      const local = localParts(user.timeZone, nowMs);

      if (inQuietHours(local.minutes, user.quietStart, user.quietEnd)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      // Pushes older than two days cannot fall on today's local date, so drop them.
      const history = (sent.get(user.id) ?? []).filter((t) => t > nowMs - TWO_DAYS_MS);
      const sentToday = history.filter(
        (t) => localParts(user.timeZone, t).date === local.date,
      ).length;

      if (sentToday >= user.dailyCap) {
        sent.set(user.id, history);
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      history.push(nowMs);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
