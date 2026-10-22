// In-memory push gate for the meal-planning agent.
// The agent calls attempt() right before a push. A call that returns
// allowed: true counts as a sent push, so the caller must send it.

const HISTORY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // > any local calendar day
const DEFAULT_QUIET_START = '22:00';
const DEFAULT_QUIET_END = '07:00';
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23', // midnight is 00, never 24
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// The user's wall clock for an instant: calendar day and minutes since midnight.
function localWallClock(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    parts[type] = value;
  }
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseHHMM(value) {
  const match = HHMM.exec(value);
  if (!match) {
    throw new TypeError(`Expected 24-hour HH:MM time, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function isQuietAt(minutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return false; // empty window: no quiet period
  if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
  return minutes >= startMinutes || minutes < endMinutes; // runs past midnight
}

export function createPushGate() {
  const sentAt = new Map(); // userId -> epoch ms of each push that was allowed

  function attempt(user, now) {
    const at = now.getTime();
    const { timeZone, dailyCap } = user;

    if (!Number.isInteger(dailyCap) || dailyCap < 0) {
      throw new TypeError(`dailyCap must be a non-negative integer, got ${JSON.stringify(dailyCap)}`);
    }

    // Night first: a push that wakes the user is the worst outcome, so it is
    // checked before the daily count.
    const quietStart = parseHHMM(user.quietStart ?? DEFAULT_QUIET_START);
    const quietEnd = parseHHMM(user.quietEnd ?? DEFAULT_QUIET_END);
    const today = localWallClock(now, timeZone);
    if (isQuietAt(today.minutes, quietStart, quietEnd)) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    // "Per day" is the user's calendar day in their own zone, not a rolling 24 h
    // and not UTC. Only pushes that were allowed are in the history.
    const history = (sentAt.get(user.id) ?? []).filter((t) => t > at - HISTORY_WINDOW_MS);
    const sentToday = history.filter(
      (t) => localWallClock(new Date(t), timeZone).dayKey === today.dayKey,
    ).length;
    if (sentToday >= dailyCap) {
      sentAt.set(user.id, history);
      return { allowed: false, reason: 'daily_cap_reached' };
    }

    history.push(at);
    sentAt.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
