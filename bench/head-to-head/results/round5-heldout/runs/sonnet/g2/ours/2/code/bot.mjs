// Push gate: decides whether a push may be sent to a user right now.
// It never sends anything. History is kept in memory only.

const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // enough to cover any zone change within the current local day

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

// Returns { day: "YYYY-MM-DD", minute: minutes since local midnight } in the zone.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

function parseClock(s) {
  const m = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  const sent = new Map(); // user id -> array of send times (ms since epoch)

  function attempt(user, now) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');
    if (!user || typeof user.id !== 'string' || user.id === '') return deny('invalid_user');

    // Unknown or invalid settings are held, never guessed.
    if (typeof user.timeZone !== 'string') return deny('invalid_time_zone');
    let local;
    try {
      local = localParts(now, user.timeZone);
    } catch {
      return deny('invalid_time_zone');
    }
    const start = parseClock(user.quietStart);
    const end = parseClock(user.quietEnd);
    if (start === null || end === null) return deny('invalid_quiet_hours');
    const cap = user.dailyCap;
    if (!Number.isInteger(cap) || cap < 0) return deny('invalid_daily_cap');

    // Quiet window includes its start minute, excludes its end minute.
    // start > end wraps past midnight. start === end is an empty window.
    const quiet =
      start < end
        ? local.minute >= start && local.minute < end
        : start > end && (local.minute >= start || local.minute < end);
    if (quiet) return deny('quiet_hours');

    // "Per day" is the user's own local calendar day.
    const nowMs = now.getTime();
    const history = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
    let today = 0;
    for (const t of history) {
      if (localParts(new Date(t), user.timeZone).day === local.day) today++;
    }
    if (today >= cap) {
      sent.set(user.id, history);
      return deny('daily_cap_reached');
    }

    history.push(nowMs);
    sent.set(user.id, history);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
