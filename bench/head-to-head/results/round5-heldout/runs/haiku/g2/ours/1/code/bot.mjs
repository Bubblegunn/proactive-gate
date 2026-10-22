// Push gate for the meal-planning agent. Decides whether a push may go now.
// It never sends anything. History is kept in memory, one gate per createPushGate() call.
//
// Choices (see the notes in the answer):
// - "Per day" is the user's own calendar day in their device time zone, not a rolling 24 hours.
// - "Night" is the user's quiet window in their device time zone. Start is included, end is excluded.
// - A window whose start is later than its end wraps past midnight. Equal start and end means no window.
// - Anything the gate cannot read (bad zone, bad HH:MM, bad cap, bad time) is held, never guessed.
// - Only allowed pushes count toward the daily cap. A refused attempt spends nothing.

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEEP_DAYS = 4;

function refuse(reason) {
  return { allowed: false, reason };
}

// Local calendar date (YYYY-MM-DD) and minute-of-day in the given IANA zone.
// Throws RangeError for an unknown zone; the caller turns that into a code.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const v = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    day: `${v.year}-${v.month}-${v.day}`,
    minutes: Number(v.hour) * 60 + Number(v.minute),
  };
}

function toMinutes(hhmm) {
  const m = HH_MM.exec(typeof hhmm === 'string' ? hhmm : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Start included, end excluded. start > end wraps past midnight. start === end is empty.
function inWindow(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function createPushGate() {
  // userId -> Map<localDay, pushesAllowed>
  const sent = new Map();

  function countFor(userId, day) {
    return sent.get(userId)?.get(day) ?? 0;
  }

  function record(userId, day) {
    let days = sent.get(userId);
    if (!days) {
      days = new Map();
      sent.set(userId, days);
    }
    days.set(day, (days.get(day) ?? 0) + 1);
    // Keep memory bounded: drop the oldest local days once there are more than KEEP_DAYS.
    while (days.size > KEEP_DAYS) {
      const oldest = [...days.keys()].sort()[0];
      days.delete(oldest);
    }
  }

  return {
    attempt(user, now) {
      if (!user || typeof user !== 'object') return refuse('invalid_user');
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return refuse('invalid_time');

      // Intl silently uses the host zone when timeZone is undefined, so require a string first.
      if (typeof user.timeZone !== 'string') return refuse('invalid_time_zone');

      let local;
      try {
        local = localParts(now, user.timeZone);
      } catch {
        return refuse('invalid_time_zone');
      }

      const start = toMinutes(user.quietStart);
      const end = toMinutes(user.quietEnd);
      if (start === null || end === null) return refuse('invalid_quiet_hours');

      const cap = user.dailyCap;
      if (!Number.isInteger(cap) || cap < 0) return refuse('invalid_daily_cap');

      if (inWindow(local.minutes, start, end)) return refuse('quiet_hours');

      if (countFor(user.id, local.day) >= cap) return refuse('daily_cap_reached');

      record(user.id, local.day);
      return { allowed: true, reason: null };
    },
  };
}
