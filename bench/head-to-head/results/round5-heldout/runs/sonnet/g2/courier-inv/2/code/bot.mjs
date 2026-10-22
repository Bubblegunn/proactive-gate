// In-memory push gate: quiet hours and a daily cap, both in the user's own time zone.

const HISTORY_KEEP_MS = 3 * 24 * 60 * 60 * 1000; // longer than any local-day length plus zone offset change

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone.
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

// Returns { day: "YYYY-MM-DD", minutes: minutes since local midnight } for the instant in the zone.
function localTime(date, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseClock(value) {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(minutes, start, end) {
  if (start === end) return false; // empty window: the user set no quiet period
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // runs past midnight
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sentByUser = new Map(); // user id -> array of send times (ms since epoch)

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');
    if (!user || typeof user.id !== 'string' || user.id === '') return deny('invalid_user_settings');

    const start = parseClock(user.quietStart);
    const end = parseClock(user.quietEnd);
    const cap = user.dailyCap;
    if (start === null || end === null || !Number.isInteger(cap) || cap < 0) {
      return deny('invalid_user_settings');
    }

    let local;
    try {
      local = localTime(now, user.timeZone);
    } catch {
      return deny('invalid_user_settings');
    }

    if (inQuietHours(local.minutes, start, end)) return deny('quiet_hours');

    // "Day" is the user's local calendar day, using the zone passed in this call.
    const nowMs = now.getTime();
    const history = (sentByUser.get(user.id) ?? []).filter((t) => t > nowMs - HISTORY_KEEP_MS);
    const sentToday = history.filter((t) => localTime(new Date(t), user.timeZone).day === local.day).length;

    if (sentToday >= cap) {
      sentByUser.set(user.id, history);
      return deny('daily_cap_reached');
    }

    history.push(nowMs);
    sentByUser.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
