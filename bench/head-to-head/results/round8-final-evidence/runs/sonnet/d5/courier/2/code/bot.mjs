// Send gate for the habit-tracking assistant. Pure: no clock, no I/O, no mutation of arguments.
//
// Rule identifiers returned in `dropped[].rule`:
//   unknown-category    category is not promo, reminder or critical
//   no-promo-opt-in     promo and the customer has not opted in (App Store Review Guideline 4.5.4)
//   dedupe-7d           same dedupeKey already sent within the last 7 days
//   unknown-time-zone   quiet hours are set but timeZone is not a valid IANA name (held, fail closed)
//   invalid-quiet-hours quiet hours are set but start/end are not valid "HH:MM" (held, fail closed)
//   quiet-hours         current local time is inside the customer's quiet hours
//   duplicate-in-batch  another candidate with the same dedupeKey and higher priority is going out now
//   frequency-cap       3 reminders+promos per rolling 24 hours already used
//
// Critical messages (fraud, account security) are transactional: they ignore opt-in for promos,
// quiet hours and the frequency cap, and they do not count toward the cap. They still obey the
// 7-day dedupeKey rule, because the policy states it without exception.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const CAP_PER_24H = 3;
const CATEGORIES = new Set(['promo', 'reminder', 'critical']);

function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes since local midnight at `date` in `timeZone`, or null if the zone is invalid.
function localMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const min = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + min;
  } catch {
    return null;
  }
}

// Returns null when sending is allowed, otherwise the rule identifier.
function quietHoursRule(user, now) {
  const qh = user.quietHours;
  if (qh == null) return null;
  const start = parseHHMM(qh.start);
  const end = parseHHMM(qh.end);
  if (start === null || end === null) return 'invalid-quiet-hours';
  if (start === end) return null; // empty window: the customer blocked no time
  const t = localMinutes(now, user.timeZone);
  if (t === null) return 'unknown-time-zone';
  const inside = start < end ? t >= start && t < end : t >= start || t < end; // wraps midnight
  return inside ? 'quiet-hours' : null;
}

function priorityOf(c) {
  return Number.isFinite(c.priority) ? c.priority : -Infinity;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  const dropped = [];

  // History facts. An unparseable sentAt counts as recent (fail closed).
  const recentKeys = new Set();
  let capUsed = 0;
  for (const h of history) {
    const t = Date.parse(h.sentAt);
    if (Number.isNaN(t) || t > nowMs - DEDUPE_WINDOW_MS) recentKeys.add(h.dedupeKey);
    if ((h.category === 'promo' || h.category === 'reminder') && (Number.isNaN(t) || t > nowMs - DAY_MS)) {
      capUsed += 1;
    }
  }

  // Per-candidate rules.
  const eligible = [];
  candidates.forEach((c, index) => {
    let rule = null;
    if (!CATEGORIES.has(c.category)) rule = 'unknown-category';
    else if (c.category === 'promo' && user.promoOptIn !== true) rule = 'no-promo-opt-in';
    else if (recentKeys.has(c.dedupeKey)) rule = 'dedupe-7d';
    else if (c.category !== 'critical') rule = quietHoursRule(user, now);
    if (rule) dropped.push({ id: c.id, rule });
    else eligible.push({ c, index });
  });

  // Best first: priority descending, then critical before others, then input order.
  eligible.sort(
    (a, b) =>
      priorityOf(b.c) - priorityOf(a.c) ||
      (b.c.category === 'critical') - (a.c.category === 'critical') ||
      a.index - b.index,
  );

  // One message per dedupeKey in this run, then the rolling cap.
  const send = [];
  const seenKeys = new Set();
  let slots = Math.max(0, CAP_PER_24H - capUsed);
  for (const { c } of eligible) {
    if (seenKeys.has(c.dedupeKey)) {
      dropped.push({ id: c.id, rule: 'duplicate-in-batch' });
      continue;
    }
    if (c.category !== 'critical') {
      if (slots === 0) {
        dropped.push({ id: c.id, rule: 'frequency-cap' });
        continue;
      }
      slots -= 1;
    }
    seenKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return { send, dropped };
}
