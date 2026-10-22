// Push gate: decides whether the agent may send a push to a user right now.
// Rules, checked in this order (a blocked attempt is never counted as sent):
//   1. quiet hours, in the user's own time zone (window may cross midnight)
//   2. daily cap, counted per calendar day in the user's own time zone
// Invalid input fails closed: no push is allowed when we cannot tell it is safe.

const HISTORY_MS = 48 * 60 * 60 * 1000; // longer than any local day, so pruning is safe

const formatters = new Map();

function localParts(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function inQuietHours(now, start, end) {
  if (start === end) return false; // empty window: no quiet period
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function createPushGate() {
  const sent = new Map(); // user id -> array of epoch ms of allowed pushes

  const deny = (reason) => ({ allowed: false, reason });

  return {
    attempt(user, now) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');
      if (!user || (typeof user.id !== 'string' && typeof user.id !== 'number')) {
        return deny('invalid_user');
      }

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return deny('invalid_time_zone');
      }

      const start = parseHHMM(user.quietStart);
      const end = parseHHMM(user.quietEnd);
      if (start === null || end === null) return deny('invalid_quiet_hours');

      const cap = user.dailyCap;
      if (typeof cap !== 'number' || Number.isNaN(cap)) return deny('invalid_daily_cap');

      if (inQuietHours(local.minutes, start, end)) return deny('quiet_hours');

      const t = now.getTime();
      const history = (sent.get(user.id) ?? []).filter((x) => x > t - HISTORY_MS);
      const today = history.filter(
        (x) => localParts(new Date(x), user.timeZone).day === local.day,
      ).length;
      if (today >= cap) {
        sent.set(user.id, history);
        return deny('daily_cap_reached');
      }

      history.push(t);
      sent.set(user.id, history);
      return { allowed: true, reason: null };
    },
  };
}
