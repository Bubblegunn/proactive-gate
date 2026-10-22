// In-memory push gate. decide() never sends; it answers whether the caller may send now.
// Marketing: skipped during the customer's quiet window and capped at 3 sends per customer-local day.
// Transactional: never blocked here (courier, security codes).

const MARKETING_DAILY_CAP = 3;

// key: `${userId}|${localDay}` -> number of marketing sends counted so far
const marketingSends = new Map();

const formatters = new Map();

function localClock(now, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone; the caller turns that into a refusal.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(now);
  const pick = (type) => parts.find((p) => p.type === type).value;
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

// "HH:MM" -> minutes after local midnight, or null when malformed.
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Start inclusive, end exclusive. start > end wraps past midnight. start === end means no window.
function inQuietWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function decide(candidate, now) {
  const refuse = (rule) => ({ send: false, rule });
  const allow = () => ({ send: true, rule: null });

  if (
    !candidate ||
    typeof candidate.userId !== 'string' ||
    candidate.userId === '' ||
    (candidate.category !== 'marketing' && candidate.category !== 'transactional') ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    return refuse('invalid-input');
  }

  if (candidate.category === 'transactional') {
    return allow();
  }

  let clock;
  try {
    clock = localClock(now, candidate.timezone);
  } catch {
    return refuse('invalid-timezone');
  }

  const quietStart = parseClock(candidate.quietStart);
  const quietEnd = parseClock(candidate.quietEnd);
  if (quietStart === null || quietEnd === null) {
    return refuse('invalid-input');
  }

  if (inQuietWindow(clock.minutes, quietStart, quietEnd)) {
    return refuse('quiet-hours');
  }

  const key = `${candidate.userId}|${clock.day}`;
  const sent = marketingSends.get(key) ?? 0;
  if (sent >= MARKETING_DAILY_CAP) {
    return refuse('daily-cap');
  }

  marketingSends.set(key, sent + 1);
  return allow();
}
