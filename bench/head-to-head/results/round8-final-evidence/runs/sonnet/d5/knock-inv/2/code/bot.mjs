// Pure send planner for the habit-tracking assistant. No clock, no I/O, no mutation of arguments.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const CAP_PER_24H = 3;
const CAPPED = new Set(['promo', 'reminder']);
const KNOWN = new Set(['promo', 'reminder', 'critical']);

function parseClock(text, label) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof text === 'string' ? text : '');
  const h = m && Number(m[1]);
  const min = m && Number(m[2]);
  if (!m || h > 23 || min > 59) throw new TypeError(`user.quietHours.${label} must be "HH:MM", got ${JSON.stringify(text)}`);
  return h * 60 + min;
}

// Minutes since local midnight in the customer's time zone (DST handled by Intl).
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

// Start inclusive, end exclusive. Window may cross midnight. start === end means no quiet window.
function inQuietHours(user, now) {
  const q = user.quietHours;
  if (!q) return false;
  const start = parseClock(q.start, 'start');
  const end = parseClock(q.end, 'end');
  if (start === end) return false;
  const m = localMinutes(now, user.timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

function toMs(sentAt) {
  const ms = Date.parse(sentAt);
  if (Number.isNaN(ms)) throw new TypeError(`history sentAt is not a valid timestamp: ${JSON.stringify(sentAt)}`);
  return ms;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('now must be a valid Date');

  const quiet = inQuietHours(user, now);

  // Only entries newer than the window count; future-dated entries count too (fail closed).
  const recentKeys = new Set();
  let usedInDay = 0;
  for (const h of history) {
    const t = toMs(h.sentAt);
    if (t > nowMs - DEDUPE_MS) recentKeys.add(h.dedupeKey);
    if (t > nowMs - DAY_MS && CAPPED.has(h.category)) usedInDay += 1;
  }

  // Critical first, then higher priority first, then input order.
  const order = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ca = a.c.category === 'critical' ? 1 : 0;
      const cb = b.c.category === 'critical' ? 1 : 0;
      return cb - ca || b.c.priority - a.c.priority || a.i - b.i;
    });

  const send = [];
  const reasons = new Map(); // input index -> rule
  const batchKeys = new Set();

  for (const { c, i } of order) {
    let rule = null;
    if (!KNOWN.has(c.category)) rule = 'unknown-category';
    else if (c.category === 'promo' && user.promoOptIn !== true) rule = 'promo-not-opted-in';
    else if (c.category !== 'critical' && quiet) rule = 'quiet-hours';
    else if (recentKeys.has(c.dedupeKey)) rule = 'dedupe-7d';
    else if (batchKeys.has(c.dedupeKey)) rule = 'dedupe-in-batch';
    else if (CAPPED.has(c.category) && usedInDay >= CAP_PER_24H) rule = 'daily-cap';

    if (rule) {
      reasons.set(i, rule);
      continue;
    }
    batchKeys.add(c.dedupeKey);
    if (CAPPED.has(c.category)) usedInDay += 1;
    send.push(c.id);
  }

  const dropped = [];
  candidates.forEach((c, i) => {
    if (reasons.has(i)) dropped.push({ id: c.id, rule: reasons.get(i) });
  });
  return { send, dropped };
}
