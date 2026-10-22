// Push gate: decides whether the agent may send a push to a user right now.
// Rules (checked in this order, first failure wins):
//   invalid_now / invalid_user_settings  - bad input; fail closed, send nothing
//   quiet_hours                          - local time is inside the user's quiet period
//   daily_cap_reached                    - user already got dailyCap pushes this local calendar day
// "Day" is the calendar day in the user's own time zone (not UTC, not a rolling 24h).
// Quiet period: start inclusive, end exclusive, may wrap past midnight.
// quietStart === quietEnd means no quiet period.
// Only allowed attempts are recorded; blocked ones never count toward the cap.

const KEEP_MS = 3 * 24 * 60 * 60 * 1000; // enough for any time zone change between calls

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
    formatters.set(timeZone, f);
  }
  return f;
}

// Returns { dayKey: "YYYY-MM-DD", minutes: minutes since local midnight }.
function localParts(date, timeZone) {
  const p = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) p[type] = value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function createPushGate() {
  const history = new Map(); // user id -> array of epoch ms of allowed pushes

  function attempt(user, now) {
    const deny = (reason) => ({ allowed: false, reason });

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_now');
    if (!user || typeof user !== 'object' || user.id == null || user.id === '') {
      return deny('invalid_user_settings');
    }

    const { id, timeZone, dailyCap } = user;
    const start = parseHHMM(user.quietStart);
    const end = parseHHMM(user.quietEnd);
    if (
      typeof timeZone !== 'string' ||
      start === null ||
      end === null ||
      !Number.isInteger(dailyCap) ||
      dailyCap < 0
    ) {
      return deny('invalid_user_settings');
    }

    let local;
    try {
      local = localParts(now, timeZone);
    } catch {
      return deny('invalid_user_settings'); // unknown IANA zone
    }

    const t = local.minutes;
    let quiet = false;
    if (start < end) quiet = t >= start && t < end;
    else if (start > end) quiet = t >= start || t < end; // wraps past midnight
    if (quiet) return deny('quiet_hours');

    const nowMs = now.getTime();
    const key = String(id);
    const recent = (history.get(key) ?? []).filter((ms) => nowMs - ms < KEEP_MS);
    const sentToday = recent.filter(
      (ms) => localParts(new Date(ms), timeZone).dayKey === local.dayKey,
    ).length;
    if (sentToday >= dailyCap) {
      history.set(key, recent);
      return deny('daily_cap_reached');
    }

    recent.push(nowMs);
    history.set(key, recent);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
