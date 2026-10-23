// Pure send planner for the habit-tracking assistant. No clock, no I/O, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const CAP_WINDOW_MS = DAY_MS;
const CAP_MAX = 3;
const CATEGORY_RANK = { critical: 0, reminder: 1, promo: 2 };

// Rule identifiers returned in `dropped[].rule`.
export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: "unknown-category",
  NO_PROMO_OPT_IN: "promo-no-opt-in",
  QUIET_HOURS: "quiet-hours",
  RECENT_DUPLICATE: "dedupe-sent-within-7d",
  BATCH_DUPLICATE: "dedupe-duplicate-in-batch",
  FREQUENCY_CAP: "frequency-cap-3-per-24h",
});

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  if (!m) throw new TypeError(`quietHours time must be "HH:MM", got ${JSON.stringify(value)}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new RangeError(`quietHours time out of range: ${value}`);
  return h * 60 + min;
}

// Minutes since local midnight in `timeZone` at instant `date` (DST-aware).
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get("hour") % 24) * 60 + get("minute");
}

// start == end is treated as "no quiet window" (not 24 h), so a bad setting cannot silence the customer.
function inQuietHours(quietHours, timeZone, now) {
  if (!quietHours) return false;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start === end) return false;
  const m = localMinutes(now, timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const nowMs = now.getTime();

  const past = history.map((h) => {
    const t = Date.parse(h.sentAt);
    if (Number.isNaN(t)) throw new TypeError(`history sentAt is not a valid timestamp: ${h.sentAt}`);
    return { t, category: h.category, dedupeKey: h.dedupeKey };
  });

  // Window starts are exclusive: a send exactly 24 h / 7 d ago no longer counts.
  const recentDedupeKeys = new Set(
    past.filter((h) => h.t > nowMs - DEDUPE_WINDOW_MS).map((h) => h.dedupeKey),
  );
  const capUsed = past.filter(
    (h) => h.t > nowMs - CAP_WINDOW_MS && (h.category === "reminder" || h.category === "promo"),
  ).length;
  let capLeft = Math.max(0, CAP_MAX - capUsed);

  const quiet = inQuietHours(user.quietHours ?? null, user.timeZone, now);

  // Best first: higher priority, then critical > reminder > promo, then input order.
  const order = candidates
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        b.c.priority - a.c.priority ||
        (CATEGORY_RANK[a.c.category] ?? 9) - (CATEGORY_RANK[b.c.category] ?? 9) ||
        a.i - b.i,
    );

  const send = [];
  const claimedKeys = new Set();
  const reasonByIndex = new Map();

  for (const { c, i } of order) {
    const isCritical = c.category === "critical";
    let rule = null;

    if (!(c.category in CATEGORY_RANK)) rule = RULES.UNKNOWN_CATEGORY;
    else if (c.category === "promo" && user.promoOptIn !== true) rule = RULES.NO_PROMO_OPT_IN;
    else if (!isCritical && quiet) rule = RULES.QUIET_HOURS;
    else if (recentDedupeKeys.has(c.dedupeKey)) rule = RULES.RECENT_DUPLICATE;
    else if (claimedKeys.has(c.dedupeKey)) rule = RULES.BATCH_DUPLICATE;
    else if (!isCritical && capLeft <= 0) rule = RULES.FREQUENCY_CAP;

    if (rule) {
      reasonByIndex.set(i, rule);
      continue;
    }
    claimedKeys.add(c.dedupeKey);
    if (!isCritical) capLeft -= 1;
    send.push(c.id);
  }

  const dropped = [];
  candidates.forEach((c, i) => {
    if (reasonByIndex.has(i)) dropped.push({ id: c.id, rule: reasonByIndex.get(i) });
  });

  return { send, dropped };
}
