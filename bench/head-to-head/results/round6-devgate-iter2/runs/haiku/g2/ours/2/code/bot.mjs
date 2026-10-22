// Push gate for the meal-planning agent.
// attempt() decides whether one push may go to one user right now. It sends nothing.
// History is in memory per gate instance. It is lost on restart, which is accepted.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// A local calendar day lasts at most 26h across DST changes. Keep 48h of history.
const KEEP_MS = 2 * DAY_MS;

const formatters = new Map();

function formatterFor(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let f;
  try {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null; // not a valid IANA zone; do not cache junk strings
  }
  formatters.set(timeZone, f);
  return f;
}

// Local calendar day (YYYY-MM-DD) and minute of day in the user's zone.
function localParts(timeZone, date) {
  const f = formatterFor(timeZone);
  if (!f) return null;
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start is inclusive, end is exclusive. start > end wraps past midnight.
// start === end means no quiet period.
function inWindow(start, end, cur) {
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> timestamps (ms) of pushes this gate allowed

  function attempt(user, now) {
    const deny = (reason) => ({ allowed: false, reason });

    if (!user || typeof user.id !== 'string' || user.id === '') return deny('invalid_user');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');

    const local = localParts(user.timeZone, now);
    if (!local) return deny('invalid_time_zone');

    let quiet = null;
    if (user.quietStart != null || user.quietEnd != null) {
      const start = toMinutes(user.quietStart);
      const end = toMinutes(user.quietEnd);
      if (start === null || end === null) return deny('invalid_quiet_hours');
      quiet = { start, end };
    }

    if (!Number.isInteger(user.dailyCap) || user.dailyCap < 0) return deny('invalid_daily_cap');

    if (quiet && inWindow(quiet.start, quiet.end, local.minutes)) return deny('quiet_hours');

    const nowMs = now.getTime();
    const recent = (sent.get(user.id) ?? []).filter((t) => nowMs - t < KEEP_MS);
    sent.set(user.id, recent);
    const sentToday = recent.filter(
      (t) => localParts(user.timeZone, new Date(t)).day === local.day,
    ).length;
    if (sentToday >= user.dailyCap) return deny('daily_cap_reached');

    recent.push(nowMs);
    return { allowed: true, reason: null };
  }

  return { attempt };
}
