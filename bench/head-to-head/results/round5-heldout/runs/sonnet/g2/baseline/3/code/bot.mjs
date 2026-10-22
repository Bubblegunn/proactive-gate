// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order:
//   1. quiet hours (user's local clock, window may cross midnight)
//   2. daily cap (user's local calendar day, not a rolling 24h and not UTC)
// A blocked attempt is not recorded. An allowed attempt is recorded as sent.

const formatters = new Map();

function localParts(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false; // empty window: no quiet hours
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // crosses midnight
}

const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // enough to cover any local day (offsets are within +-14h)

export function createPushGate() {
  const sent = new Map(); // user id -> array of epoch ms of pushes allowed

  function attempt(user, now) {
    const t = now instanceof Date ? now.getTime() : NaN;
    if (!user || typeof user.id !== "string" || Number.isNaN(t)) {
      return { allowed: false, reason: "invalid_input" };
    }
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    const cap = user.dailyCap;
    if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: "invalid_user_settings" };
    }

    let local;
    try {
      local = localParts(now, user.timeZone);
    } catch {
      return { allowed: false, reason: "invalid_user_settings" };
    }

    if (inQuietHours(local.minutes, start, end)) {
      return { allowed: false, reason: "quiet_hours" };
    }

    const history = (sent.get(user.id) ?? []).filter((ms) => t - ms < KEEP_MS);
    const today = history.filter(
      (ms) => localParts(new Date(ms), user.timeZone).dayKey === local.dayKey,
    ).length;
    if (today >= cap) {
      sent.set(user.id, history);
      return { allowed: false, reason: "daily_cap_reached" };
    }

    history.push(t);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
