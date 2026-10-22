// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order:
//   1. quiet hours (user's local clock, may span midnight)  -> "quiet_hours"
//   2. daily cap (user's local calendar day, not 24h rolling) -> "daily_cap_reached"
//   3. minimum gap between pushes (no bursts)               -> "too_soon_after_last_push"
// Bad input fails closed (no push): "invalid_time", "invalid_user_settings".

const MIN_GAP_MS = 30 * 60 * 1000;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // enough to cover any local day in any zone

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f); // throws RangeError on an unknown zone, before caching
  }
  return f;
}

// Local wall-clock parts of a UTC instant in the given zone.
function localParts(ms, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(ms)) p[type] = value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false; // empty window: no quiet period
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // runs past midnight
}

export function createPushGate() {
  const sent = new Map(); // user id -> ascending array of send times (ms)

  return {
    attempt(user, now) {
      const nowMs = now instanceof Date ? now.getTime() : NaN;
      if (!Number.isFinite(nowMs)) return { allowed: false, reason: 'invalid_time' };

      const start = parseHHMM(user?.quietStart);
      const end = parseHHMM(user?.quietEnd);
      const cap = user?.dailyCap;
      if (
        typeof user?.id !== 'string' || start === null || end === null ||
        !Number.isInteger(cap) || cap < 0
      ) {
        return { allowed: false, reason: 'invalid_user_settings' };
      }

      let today;
      try {
        today = localParts(nowMs, user.timeZone);
      } catch {
        return { allowed: false, reason: 'invalid_user_settings' };
      }

      if (inQuietHours(today.minutes, start, end)) {
        return { allowed: false, reason: 'quiet_hours' };
      }

      const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
      sent.set(user.id, history);

      // Only pushes at or before now count; a caller clock that steps back must not undercount.
      const countToday = history.filter(
        (t) => localParts(t, user.timeZone).dayKey === today.dayKey,
      ).length;
      if (countToday >= cap) return { allowed: false, reason: 'daily_cap_reached' };

      const last = history.length ? history[history.length - 1] : null;
      if (last !== null && Math.abs(nowMs - last) < MIN_GAP_MS) {
        return { allowed: false, reason: 'too_soon_after_last_push' };
      }

      history.push(nowMs);
      history.sort((a, b) => a - b);
      return { allowed: true, reason: null };
    },
  };
}
