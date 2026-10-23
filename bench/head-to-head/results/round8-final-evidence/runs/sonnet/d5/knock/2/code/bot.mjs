// Send gate for the habit-tracking assistant.
// Pure: no clock, no file access, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const MAX_CAPPED_PER_24H = 3;

// Rule identifiers returned in `dropped`.
export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: 'unknown-category',
  NO_PROMO_OPT_IN: 'promo-no-opt-in', // Apple guideline 4.5.4: promo push needs explicit opt-in
  QUIET_HOURS: 'quiet-hours',
  QUIET_HOURS_INVALID: 'quiet-hours-invalid', // fail closed for non-critical
  RECENT_DUPLICATE: 'dedupe-7d',
  BATCH_DUPLICATE: 'dedupe-same-batch',
  FREQUENCY_CAP: 'frequency-cap-24h',
});

const CAPPED = new Set(['promo', 'reminder']);
const KNOWN = new Set(['promo', 'reminder', 'critical']);

function parseClock(value) {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function localMinutesOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get('hour') % 24) * 60 + get('minute');
}

// Returns true / false, or null when the window is malformed.
// start === end is treated as "no quiet window" (zero length).
function inQuietHours(quietHours, now, timeZone) {
  if (!quietHours) return false;
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  if (start === null || end === null) return null;
  if (start === end) return false;
  const minutes = localMinutesOfDay(now, timeZone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const nowMs = now.getTime();

  // Throws RangeError for an invalid IANA name.
  const quiet = inQuietHours(user.quietHours, now, user.timeZone);

  const cappedSince = nowMs - DAY_MS;
  const dedupeSince = nowMs - DEDUPE_WINDOW_MS;
  let cappedInLast24h = 0;
  const recentKeys = new Set();
  for (const h of history) {
    const t = Date.parse(h.sentAt);
    if (Number.isNaN(t)) throw new TypeError(`history sentAt is not a valid timestamp: ${h.sentAt}`);
    if (t > dedupeSince) recentKeys.add(h.dedupeKey);
    if (t > cappedSince && CAPPED.has(h.category)) cappedInLast24h += 1;
  }
  let slots = Math.max(0, MAX_CAPPED_PER_24H - cappedInLast24h);

  // Best first; ties keep input order. Sort a copy.
  const priorityOf = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  const ordered = candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const pa = priorityOf(a.c);
      const pb = priorityOf(b.c);
      return pa === pb ? a.index - b.index : pb > pa ? 1 : -1;
    })
    .map((x) => x.c);

  const send = [];
  const dropped = [];
  const batchKeys = new Set();
  const drop = (c, rule) => dropped.push({ id: c.id, rule });

  for (const c of ordered) {
    if (!KNOWN.has(c.category)) { drop(c, RULES.UNKNOWN_CATEGORY); continue; }

    const critical = c.category === 'critical';

    // Critical (fraud / account security) is transactional: it ignores promo
    // opt-in, quiet hours and the 24h cap, and does not use up cap slots.
    if (!critical) {
      if (c.category === 'promo' && user.promoOptIn !== true) { drop(c, RULES.NO_PROMO_OPT_IN); continue; }
      if (quiet === null) { drop(c, RULES.QUIET_HOURS_INVALID); continue; }
      if (quiet) { drop(c, RULES.QUIET_HOURS); continue; }
    }

    if (recentKeys.has(c.dedupeKey)) { drop(c, RULES.RECENT_DUPLICATE); continue; }
    if (batchKeys.has(c.dedupeKey)) { drop(c, RULES.BATCH_DUPLICATE); continue; }

    if (!critical) {
      if (slots === 0) { drop(c, RULES.FREQUENCY_CAP); continue; }
      slots -= 1;
    }

    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return { send, dropped };
}
