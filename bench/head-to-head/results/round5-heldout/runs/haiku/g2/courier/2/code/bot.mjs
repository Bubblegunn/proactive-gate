// Push gate for the meal-planning agent.
//
// Decides whether a push may be sent to a user right now. Each allowed call
// counts as a sent push. Rules, checked in this order:
//   1. quiet_hours       - inside the user's quiet period, in the user's time zone
//   2. daily_cap_reached - user already got dailyCap pushes on this local calendar day
//   3. min_gap           - last push was less than MIN_GAP_MS ago
//
// "Day" means the user's local calendar date, so the count resets at their
// local midnight, not at UTC midnight. "Night" means the user's quiet period
// in their local clock, so it stays correct across DST changes.

const MIN_GAP_MS = 30 * 60 * 1000;
const HISTORY_MS = 48 * 60 * 60 * 1000;
const DEFAULT_QUIET_START = "22:00";
const DEFAULT_QUIET_END = "07:00";
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();

// Local calendar date ("YYYY-MM-DD") and minute of day (0-1439) for `date` in `timeZone`.
function localParts(date, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm);
  if (!m) throw new TypeError(`quiet time must be HH:MM, got ${JSON.stringify(hhmm)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Quiet period [start, end). Equal start and end means no quiet period.
// start > end means the period wraps past midnight (e.g. 22:00-07:00).
function isQuiet(minute, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minute >= startMin && minute < endMin;
  return minute >= startMin || minute < endMin;
}

function validate(user, now) {
  if (!user || typeof user.id !== "string" || user.id === "") {
    throw new TypeError("user.id must be a non-empty string");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
    throw new TypeError("user.dailyCap must be a non-negative integer");
  }
  // Throws RangeError for an unknown IANA zone.
  new Intl.DateTimeFormat("en-CA", { timeZone: user.timeZone });
}

export function createPushGate() {
  // userId -> epoch ms of pushes allowed in the last HISTORY_MS
  const sent = new Map();

  return {
    attempt(user, now) {
      validate(user, now);

      const t = now.getTime();
      const today = localParts(now, user.timeZone);
      const startMin = toMinutes(user.quietStart ?? DEFAULT_QUIET_START);
      const endMin = toMinutes(user.quietEnd ?? DEFAULT_QUIET_END);

      const history = (sent.get(user.id) ?? []).filter((x) => t - x < HISTORY_MS);
      const save = () => {
        if (history.length) sent.set(user.id, history);
        else sent.delete(user.id);
      };
      const deny = (reason) => {
        save();
        return { allowed: false, reason };
      };

      if (isQuiet(today.minute, startMin, endMin)) return deny("quiet_hours");

      const sentToday = history.filter(
        (x) => localParts(new Date(x), user.timeZone).day === today.day,
      ).length;
      if (sentToday >= user.dailyCap) return deny("daily_cap_reached");

      const last = history.length ? Math.max(...history) : null;
      if (last !== null && t - last < MIN_GAP_MS) return deny("min_gap");

      history.push(t);
      save();
      return { allowed: true, reason: null };
    },
  };
}
