// Send gate for the habit-tracking assistant. Pure: no clock, no I/O, no mutation of arguments.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const MAX_CAPPED_PER_DAY = 3;

// Rule identifiers returned in `dropped`.
export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: 'unknown-category',
  NO_PROMO_OPT_IN: 'promo-no-opt-in',
  QUIET_HOURS: 'quiet-hours',
  DEDUPE_7D: 'dedupe-7d',
  DUPLICATE_IN_BATCH: 'duplicate-in-batch',
  RATE_CAP_24H: 'rate-cap-24h',
});

const CATEGORIES = new Set(['promo', 'reminder', 'critical']);

function parseHHMM(value, name) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) throw new RangeError(`user.quietHours.${name} must be "HH:MM" (00:00-23:59), got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes since local midnight at `instant` in `timeZone`. Throws RangeError for an unknown zone.
function localMinutes(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

// Start is inclusive, end is exclusive. A window that wraps midnight (22:00-07:00) is supported.
// start === end is an empty window, not a 24-hour one.
function inQuietHours(quietHours, minutes) {
  if (!quietHours) return false;
  const start = parseHHMM(quietHours.start, 'start');
  const end = parseHHMM(quietHours.end, 'end');
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const nowMs = now.getTime();

  const localMin = localMinutes(now, user.timeZone);
  const quiet = inQuietHours(user.quietHours ?? null, localMin);

  // Everything already sent to this customer, as epoch ms. An unparseable timestamp is treated as
  // "just now" so a corrupt record can only hold messages back, never let extra ones through.
  const sent = history.map((h) => {
    const t = Date.parse(h.sentAt);
    return { t: Number.isNaN(t) ? nowMs : t, category: h.category, dedupeKey: h.dedupeKey };
  });

  const recentKeys = new Set(sent.filter((h) => h.t > nowMs - DEDUPE_MS).map((h) => h.dedupeKey));
  const cappedInLast24h = sent.filter((h) => h.category !== 'critical' && h.t > nowMs - DAY_MS).length;

  const dropped = new Map(); // id -> rule, keyed so output follows input order
  const eligible = [];

  candidates.forEach((c, index) => {
    if (!CATEGORIES.has(c.category)) return dropped.set(c.id, RULES.UNKNOWN_CATEGORY);
    // App Store Review Guideline 4.5.4: no promotional messaging without explicit opt-in.
    if (c.category === 'promo' && user.promoOptIn !== true) return dropped.set(c.id, RULES.NO_PROMO_OPT_IN);
    // Critical (fraud, account security) is transactional and exempt from quiet hours.
    if (c.category !== 'critical' && quiet) return dropped.set(c.id, RULES.QUIET_HOURS);
    if (recentKeys.has(c.dedupeKey)) return dropped.set(c.id, RULES.DEDUPE_7D);
    eligible.push({ c, index });
  });

  // Critical first, then higher priority, then original order for a stable result.
  eligible.sort((a, b) => {
    const ac = a.c.category === 'critical' ? 1 : 0;
    const bc = b.c.category === 'critical' ? 1 : 0;
    return bc - ac || b.c.priority - a.c.priority || a.index - b.index;
  });

  const send = [];
  const batchKeys = new Set();
  let capped = cappedInLast24h;
  for (const { c } of eligible) {
    if (batchKeys.has(c.dedupeKey)) {
      dropped.set(c.id, RULES.DUPLICATE_IN_BATCH);
      continue;
    }
    if (c.category !== 'critical') {
      if (capped >= MAX_CAPPED_PER_DAY) {
        dropped.set(c.id, RULES.RATE_CAP_24H);
        continue;
      }
      capped += 1;
    }
    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return {
    send,
    dropped: candidates.filter((c) => dropped.has(c.id)).map((c) => ({ id: c.id, rule: dropped.get(c.id) })),
  };
}
