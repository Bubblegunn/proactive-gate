// Decides which candidate messages may go out now. Pure: no clock, no I/O,
// no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const MAX_CAPPED_PER_24H = 3;

const CAPPED_CATEGORIES = new Set(['promo', 'reminder']);
const KNOWN_CATEGORIES = new Set(['promo', 'reminder', 'critical']);

export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: 'unknown-category',
  PROMO_NO_OPT_IN: 'promo-no-opt-in',
  QUIET_HOURS: 'quiet-hours',
  DEDUPE_HISTORY: 'dedupe-7d',
  DEDUPE_BATCH: 'dedupe-same-batch',
  RATE_LIMIT: 'rate-limit-24h',
});

function parseHHMM(value, field) {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? '');
  const h = m && Number(m[1]);
  const min = m && Number(m[2]);
  if (!m || h > 23 || min > 59) {
    throw new TypeError(`user.quietHours.${field} must be "HH:MM", got ${JSON.stringify(value)}`);
  }
  return h * 60 + min;
}

// Minutes since local midnight for `now` in `timeZone`.
function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

// Start inclusive, end exclusive. A window may cross midnight (22:00-07:00).
// start === end is an empty window.
function inQuietHours(user, now) {
  const q = user.quietHours;
  if (!q) return false;
  const start = parseHHMM(q.start, 'start');
  const end = parseHHMM(q.end, 'end');
  if (start === end) return false;
  const t = localMinutes(now, user.timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('now must be a valid Date');

  const quiet = inQuietHours(user, now);

  // Entries dated in the future count as recent, the safer reading.
  let cappedInLast24h = 0;
  const recentKeys = new Set();
  for (const h of history) {
    const sentMs = Date.parse(h.sentAt);
    if (Number.isNaN(sentMs)) {
      throw new TypeError(`history sentAt is not a valid timestamp: ${JSON.stringify(h.sentAt)}`);
    }
    const age = nowMs - sentMs;
    if (age < DEDUPE_WINDOW_MS) recentKeys.add(h.dedupeKey);
    if (age < DAY_MS && CAPPED_CATEGORIES.has(h.category)) cappedInLast24h++;
  }
  let slotsLeft = Math.max(0, MAX_CAPPED_PER_24H - cappedInLast24h);

  // Best first; equal priority keeps input order. Copy so the argument is untouched.
  const ordered = candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.priority - a.c.priority || a.index - b.index)
    .map(({ c }) => c);

  const send = [];
  const dropped = [];
  const batchKeys = new Set();
  const drop = (c, rule) => dropped.push({ id: c.id, rule });

  for (const c of ordered) {
    const capped = CAPPED_CATEGORIES.has(c.category);

    if (!KNOWN_CATEGORIES.has(c.category)) drop(c, RULES.UNKNOWN_CATEGORY);
    // Apple App Store Review Guideline 4.5.4: no promotional push without explicit opt-in.
    else if (c.category === 'promo' && !user.promoOptIn) drop(c, RULES.PROMO_NO_OPT_IN);
    // Critical (fraud/security) alerts are transactional: they ignore quiet hours and the cap.
    else if (capped && quiet) drop(c, RULES.QUIET_HOURS);
    else if (recentKeys.has(c.dedupeKey)) drop(c, RULES.DEDUPE_HISTORY);
    else if (batchKeys.has(c.dedupeKey)) drop(c, RULES.DEDUPE_BATCH);
    else if (capped && slotsLeft === 0) drop(c, RULES.RATE_LIMIT);
    else {
      send.push(c.id);
      batchKeys.add(c.dedupeKey);
      if (capped) slotsLeft--;
    }
  }

  return { send, dropped };
}
