// Push gate for the meal-planning agent.
//
// The agent calls attempt() right before it sends a push. A "allowed: true"
// answer counts as a push sent, so the gate records it. History lives in
// memory only; nothing is persisted across restarts.
//
// Rules, checked in this order:
//   1. quiet_hours        - the user's local clock is inside their quiet period.
//   2. daily_cap_reached  - the user already got dailyCap pushes today
//                           (today = the user's local calendar day).
//   3. too_soon           - another push went to this user less than
//                           MIN_GAP_MS ago. Keeps pushes from arriving in bursts.
//
// Apple (HIG, Notifications) and Google (Android notification guidance) both
// ask apps to send only what the user cares about, to avoid interrupting
// people at unwanted times, and to keep volume low. The three rules above
// follow that.

const MIN_GAP_MS = 60 * 60 * 1000;
const HISTORY_KEEP_MS = 48 * 60 * 60 * 1000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatters = new Map();

function getPartsFormatter(timeZone) {
  let formatter = partsFormatters.get(timeZone);
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
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

// Wall-clock fields of `date` as seen in `timeZone`.
function localParts(date, timeZone) {
  const out = {};
  for (const { type, value } of getPartsFormatter(timeZone).formatToParts(date)) {
    out[type] = value;
  }
  return {
    day: `${out.year}-${out.month}-${out.day}`,
    minutes: Number(out.hour) * 60 + Number(out.minute),
  };
}

function parseHHMM(value, name) {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) {
    throw new TypeError(`${name} must be an HH:MM string, got ${JSON.stringify(value)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

// True when `minutes` falls in [start, end). A range with start > end wraps past
// midnight (22:00-07:00). start === end means no quiet period.
function inQuietPeriod(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function createPushGate() {
  // userId -> epoch ms of each push that was allowed.
  const sent = new Map();

  function recentSends(userId, now) {
    const history = sent.get(userId) ?? [];
    const kept = history.filter((t) => now - t < HISTORY_KEEP_MS && t - now < HISTORY_KEEP_MS);
    sent.set(userId, kept);
    return kept;
  }

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
      }
      if (!user || typeof user.id !== 'string') {
        throw new TypeError('user.id must be a string');
      }
      if (typeof user.timeZone !== 'string') {
        throw new TypeError('user.timeZone must be an IANA zone name');
      }
      if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) {
        throw new TypeError('user.dailyCap must be a non-negative integer');
      }

      const nowMs = now.getTime();
      const local = localParts(now, user.timeZone);

      const quietStart = parseHHMM(user.quietStart, 'user.quietStart');
      const quietEnd = parseHHMM(user.quietEnd, 'user.quietEnd');
      if (inQuietPeriod(local.minutes, quietStart, quietEnd)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const history = recentSends(user.id, nowMs);

      const sentToday = history.filter(
        (t) => localParts(new Date(t), user.timeZone).day === local.day,
      ).length;
      if (sentToday >= user.dailyCap) {
        return { allowed: false, reason: 'daily_cap_reached' };
      }

      if (history.some((t) => Math.abs(nowMs - t) < MIN_GAP_MS)) {
        return { allowed: false, reason: 'too_soon' };
      }

      history.push(nowMs);
      return { allowed: true, reason: null };
    },
  };
}
