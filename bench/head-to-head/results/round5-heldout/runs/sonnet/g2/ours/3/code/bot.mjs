// Push gate: decides whether the agent may send a push to a user right now.
// It never sends anything. History is in memory, one independent store per gate.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const formatters = new Map();

function localParts(date, timeZone) {
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
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseMinutes(s) {
  const m = typeof s === 'string' ? HHMM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const deny = (reason) => ({ allowed: false, reason });

export function createPushGate() {
  // user id -> timestamps (ms) of pushes this gate allowed
  const sent = new Map();

  return {
    attempt(user, now) {
      if (!user || typeof user.id !== 'string' || user.id === '') return deny('invalid_user');
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');

      // Unknown or invalid settings are held, never guessed.
      let zone;
      try {
        if (typeof user.timeZone !== 'string' || user.timeZone === '') throw new Error();
        zone = localParts(now, user.timeZone);
      } catch {
        return deny('invalid_time_zone');
      }
      const start = parseMinutes(user.quietStart);
      const end = parseMinutes(user.quietEnd);
      if (start === null || end === null) return deny('invalid_quiet_hours');
      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) return deny('invalid_daily_cap');

      // Quiet window includes its start minute, excludes its end minute.
      // start > end wraps past midnight. start === end means no quiet window.
      const t = zone.minutes;
      const quiet = start < end ? t >= start && t < end : start > end ? t >= start || t < end : false;
      if (quiet) return deny('quiet_hours');

      // "Day" is the user's own calendar day in their current time zone.
      const history = sent.get(user.id) ?? [];
      let today = 0;
      for (const ts of history) {
        if (localParts(new Date(ts), user.timeZone).day === zone.day) today++;
      }
      if (today >= cap) return deny('daily_cap_reached');

      history.push(now.getTime());
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
