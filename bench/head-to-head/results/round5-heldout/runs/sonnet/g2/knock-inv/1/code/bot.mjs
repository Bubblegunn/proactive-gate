// Push gate: decides whether the agent may send a push to a user right now.
//
// Rules, checked in this order:
//   1. Quiet hours (invalid_settings is checked before them).
//      The user's own quietStart..quietEnd window, read on the clock of the
//      user's own time zone. start is inclusive, end is exclusive. A window
//      with start later than end runs past midnight. start equal to end is an
//      empty window (no quiet hours).
//   2. Daily cap. "Day" is the user's local calendar day (midnight to midnight
//      in user.timeZone), not UTC and not a rolling 24 hours. Only pushes this
//      gate allowed count. Blocked attempts never count.
//
// Reason codes: invalid_settings, quiet_hours, daily_cap_reached.
// Invalid input fails closed: a skipped push costs less than a wrong one.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A local day is at most 25 h long and zones differ by up to 26 h, so history
// older than this can never share a local day with "now".
const KEEP_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar date ("2026-03-08") and minutes since local midnight.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    p[type] = value;
  }
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function toMinutes(hhmm) {
  const m = typeof hhmm === "string" ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sent = new Map(); // user id -> timestamps (ms) of allowed pushes

  return {
    attempt(user, now) {
      const nowMs = now instanceof Date ? now.getTime() : NaN;
      if (!user || typeof user !== "object" || Number.isNaN(nowMs)) {
        return deny("invalid_settings");
      }
      const { id, timeZone, quietStart, quietEnd, dailyCap } = user;
      const start = toMinutes(quietStart);
      const end = toMinutes(quietEnd);
      if (
        id == null ||
        start === null ||
        end === null ||
        !Number.isInteger(dailyCap) ||
        dailyCap < 0 ||
        typeof timeZone !== "string"
      ) {
        return deny("invalid_settings");
      }

      let local;
      try {
        local = localParts(now, timeZone);
      } catch {
        return deny("invalid_settings"); // unknown IANA zone
      }

      if (inQuietHours(local.minutes, start, end)) return deny("quiet_hours");

      const history = (sent.get(id) ?? []).filter((t) => t > nowMs - KEEP_MS);
      // Re-read each past push in the zone passed on this call, so a user who
      // changes zone gets today's count for where they are now.
      const today = history.filter(
        (t) => localParts(new Date(t), timeZone).day === local.day,
      ).length;
      if (today >= dailyCap) {
        sent.set(id, history);
        return deny("daily_cap_reached");
      }

      history.push(nowMs);
      sent.set(id, history);
      return { allowed: true, reason: null };
    },
  };
}
