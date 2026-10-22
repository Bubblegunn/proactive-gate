// In-memory gate for agent-initiated push notifications.
// attempt(user, now) -> { allowed, reason }. An allowed call counts as a push sent.

const HOUR_MS = 3600 * 1000;
// A local day is at most 24h long (25h on a DST change); zone offsets differ by at most 26h.
// Keep sends for 72h so every send that can share a local day with `now` stays counted.
const KEEP_MS = 72 * HOUR_MS;

const formatters = new Map();

function localParts(timeZone, date) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
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
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseClock(value) {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of send times (ms since epoch)

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, reason: "invalid_time" };
    }
    if (!user || typeof user.id !== "string" || user.id === "") {
      return { allowed: false, reason: "invalid_user" };
    }

    let local;
    try {
      if (typeof user.timeZone !== "string" || user.timeZone === "") throw new RangeError();
      local = localParts(user.timeZone, now);
    } catch {
      // Unknown zone: never guess a local time.
      return { allowed: false, reason: "invalid_time_zone" };
    }

    const start = parseClock(user.quietStart);
    const end = parseClock(user.quietEnd);
    if (start === null || end === null) {
      return { allowed: false, reason: "invalid_quiet_hours" };
    }

    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) {
      return { allowed: false, reason: "invalid_daily_cap" };
    }

    // Quiet window includes its start minute and excludes its end minute.
    // start === end is an empty window. start > end wraps past midnight.
    const m = local.minutes;
    const quiet = start < end ? m >= start && m < end : start > end ? m >= start || m < end : false;
    if (quiet) return { allowed: false, reason: "quiet_hours" };

    const nowMs = now.getTime();
    const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS && t - nowMs < KEEP_MS);

    // "Per day" is the user's own calendar day in their zone.
    let today = 0;
    for (const t of history) {
      if (localParts(user.timeZone, new Date(t)).day === local.day) today++;
    }
    if (today >= cap) {
      sent.set(user.id, history);
      return { allowed: false, reason: "daily_cap_reached" };
    }

    history.push(nowMs);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
