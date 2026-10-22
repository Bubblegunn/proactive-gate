// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order:
//   1. quiet hours, in the user's own time zone (start inclusive, end exclusive)
//   2. daily cap, counted per calendar day in the user's own time zone
// A blocked attempt is not recorded. An allowed attempt is recorded as sent.

const HISTORY_MS = 72 * 3600 * 1000; // longer than any local day, in any zone
const SWEEP_EVERY_MS = 3600 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Returns { day: "YYYY-MM-DD", minutes: minutes since local midnight }.
function localParts(ms, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(ms)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseClock(s) {
  const m = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false; // no quiet period configured
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // runs past midnight
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sent = new Map(); // user id -> array of send times (ms)
  let lastSweep = -Infinity;

  function sweep(nowMs) {
    if (nowMs - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = nowMs;
    for (const [id, times] of sent) {
      const kept = times.filter((t) => t > nowMs - HISTORY_MS);
      if (kept.length) sent.set(id, kept);
      else sent.delete(id);
    }
  }

  return {
    attempt(user, now) {
      const nowMs = now instanceof Date ? now.getTime() : NaN;
      if (!Number.isFinite(nowMs)) return deny('invalid_time');

      if (!user || typeof user !== 'object' || user.id == null || user.id === '') {
        return deny('invalid_user_settings');
      }
      const start = parseClock(user.quietStart);
      const end = parseClock(user.quietEnd);
      const cap = user.dailyCap;
      if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
        return deny('invalid_user_settings');
      }
      let here;
      try {
        here = localParts(nowMs, user.timeZone);
      } catch {
        return deny('invalid_user_settings');
      }

      if (inQuietHours(here.minutes, start, end)) return deny('quiet_hours');

      sweep(nowMs);
      const times = sent.get(user.id) ?? [];
      // Re-derive each past push's local day in the zone passed now, so a
      // user who changes zone is still counted by the day they are living.
      let today = 0;
      for (const t of times) {
        if (localParts(t, user.timeZone).day === here.day) today++;
      }
      if (today >= cap) return deny('daily_cap_reached');

      times.push(nowMs);
      sent.set(user.id, times);
      return { allowed: true, reason: null };
    },
  };
}
