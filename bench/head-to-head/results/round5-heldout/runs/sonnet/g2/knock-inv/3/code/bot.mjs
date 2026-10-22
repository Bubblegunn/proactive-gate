// Push gate for the notification agent.
//
// Rules, checked in this order:
//   1. invalid_settings / invalid_time: input cannot be read, so fail closed.
//   2. quiet_hours: the user's local time is inside quietStart..quietEnd.
//   3. daily_cap_reached: the user already got dailyCap pushes today.
//
// "Day" is the calendar day on the user's own clock (their IANA zone), not UTC
// and not a rolling 24 hours. "Night" is the quiet window the user set, read in
// their zone. Only allowed attempts count toward the cap; blocked ones do not.

const HISTORY_MS = 72 * 60 * 60 * 1000; // longer than any local day, even across a zone change

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
    formatters.set(timeZone, fmt); // throws RangeError on an unknown zone, so bad zones are never cached
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseClock(value) {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Quiet window is [start, end). It wraps past midnight when start > end.
// start === end means the user set no quiet period.
function inQuietHours(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of Date.getTime() of allowed pushes

  return {
    attempt(user, now) {
      const time = now instanceof Date ? now.getTime() : NaN;
      if (Number.isNaN(time)) return { allowed: false, reason: "invalid_time" };

      const start = parseClock(user?.quietStart);
      const end = parseClock(user?.quietEnd);
      const cap = user?.dailyCap;
      if (
        typeof user?.id !== "string" ||
        typeof user.timeZone !== "string" ||
        start === null ||
        end === null ||
        !Number.isInteger(cap) ||
        cap < 0
      ) {
        return { allowed: false, reason: "invalid_settings" };
      }

      let today;
      try {
        today = localParts(user.timeZone, now);
      } catch {
        return { allowed: false, reason: "invalid_settings" };
      }

      if (inQuietHours(today.minutes, start, end)) {
        return { allowed: false, reason: "quiet_hours" };
      }

      const history = (sent.get(user.id) ?? []).filter((t) => time - t < HISTORY_MS);
      const todayCount = history.filter(
        (t) => localParts(user.timeZone, new Date(t)).dayKey === today.dayKey
      ).length;
      if (todayCount >= cap) {
        sent.set(user.id, history);
        return { allowed: false, reason: "daily_cap_reached" };
      }

      history.push(time);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
