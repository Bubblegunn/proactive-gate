// Pure send planner for the habit-tracking assistant.
// No clock, no file access, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CAP_WINDOW_MS = DAY_MS;
const CAP_MAX = 3; // reminders + promos per rolling 24 h
const DEDUPE_WINDOW_MS = 7 * DAY_MS;

const CATEGORIES = new Set(['promo', 'reminder', 'critical']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Rule identifiers returned in `dropped[].rule`.
export const RULES = Object.freeze({
  INVALID_CATEGORY: 'invalid-category',
  PROMO_NO_OPT_IN: 'promo-no-opt-in', // App Store 4.5.4: marketing push needs explicit opt-in
  INVALID_TIME_ZONE: 'invalid-time-zone',
  INVALID_QUIET_HOURS: 'invalid-quiet-hours',
  QUIET_HOURS: 'quiet-hours',
  DEDUPE_7D: 'dedupe-7d',
  DEDUPE_IN_BATCH: 'dedupe-in-batch',
  CAP_24H: 'cap-24h',
});

function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Minutes since local midnight in `timeZone`, or null when the zone is invalid.
function localMinutes(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch {
    return null;
  }
}

// Start inclusive, end exclusive. Window may wrap midnight (22:00-07:00).
// start === end is a zero-length window: never quiet.
function inWindow(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// Quiet-hours state: { state: 'none' | 'quiet' | 'ok' | 'bad-zone' | 'bad-window' }
function quietState(user, now) {
  const qh = user?.quietHours;
  if (qh == null) return 'ok';
  const start = parseHHMM(qh.start);
  const end = parseHHMM(qh.end);
  if (start === null || end === null) return 'bad-window';
  const minute = localMinutes(now, user.timeZone);
  if (minute === null) return 'bad-zone';
  return inWindow(minute, start, end) ? 'quiet' : 'ok';
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('planSends: `now` must be a valid Date');
  }
  const nowMs = now.getTime();
  const hist = Array.isArray(history) ? history : [];
  const cands = Array.isArray(candidates) ? candidates : [];

  // History facts. An unparseable sentAt is treated as "just sent" (fail closed).
  const recentKeys = new Set();
  let capUsed = 0;
  for (const h of hist) {
    let t = Date.parse(h?.sentAt);
    if (Number.isNaN(t)) t = nowMs;
    if (t > nowMs - DEDUPE_WINDOW_MS) recentKeys.add(h?.dedupeKey);
    if ((h?.category === 'reminder' || h?.category === 'promo') && t > nowMs - CAP_WINDOW_MS) {
      capUsed += 1;
    }
  }

  const quiet = quietState(user, now);

  // Best first: critical above everything, then higher priority; ties keep input order.
  const ordered = cands
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ca = a.c.category === 'critical' ? 1 : 0;
      const cb = b.c.category === 'critical' ? 1 : 0;
      if (ca !== cb) return cb - ca;
      const pa = Number.isFinite(a.c.priority) ? a.c.priority : -Infinity;
      const pb = Number.isFinite(b.c.priority) ? b.c.priority : -Infinity;
      if (pa !== pb) return pb > pa ? 1 : -1;
      return a.i - b.i;
    })
    .map((x) => x.c);

  const send = [];
  const dropped = [];
  const sentKeys = new Set();
  let capLeft = Math.max(0, CAP_MAX - capUsed);

  for (const c of ordered) {
    const drop = (rule) => dropped.push({ id: c.id, rule });

    if (!CATEGORIES.has(c.category)) {
      drop(RULES.INVALID_CATEGORY);
      continue;
    }
    const critical = c.category === 'critical';

    // Critical (fraud / account security) is transactional: it ignores
    // promo opt-in, quiet hours and the 24 h cap. Dedupe still applies.
    if (!critical) {
      if (c.category === 'promo' && user?.promoOptIn !== true) {
        drop(RULES.PROMO_NO_OPT_IN);
        continue;
      }
      if (quiet === 'bad-window') {
        drop(RULES.INVALID_QUIET_HOURS);
        continue;
      }
      if (quiet === 'bad-zone') {
        drop(RULES.INVALID_TIME_ZONE);
        continue;
      }
      if (quiet === 'quiet') {
        drop(RULES.QUIET_HOURS);
        continue;
      }
    }
    if (recentKeys.has(c.dedupeKey)) {
      drop(RULES.DEDUPE_7D);
      continue;
    }
    if (sentKeys.has(c.dedupeKey)) {
      drop(RULES.DEDUPE_IN_BATCH);
      continue;
    }
    if (!critical) {
      if (capLeft <= 0) {
        drop(RULES.CAP_24H);
        continue;
      }
      capLeft -= 1;
    }
    sentKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return { send, dropped };
}
