// Send gate for the habit-tracking assistant. Pure: no clock, no I/O, no mutation of arguments.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const DAILY_CAP = 3; // reminders + promos per rolling 24 hours
const CATEGORIES = new Set(["promo", "reminder", "critical"]);

// Rule identifiers, one per reason a candidate can be held.
export const RULES = Object.freeze({
  INVALID_CATEGORY: "invalid-category",
  INVALID_PRIORITY: "invalid-priority",
  NO_PROMO_OPT_IN: "promo-no-opt-in",
  QUIET_HOURS: "quiet-hours",
  RECENT_DUPLICATE: "dedupe-7-days",
  BATCH_DUPLICATE: "dedupe-same-batch",
  DAILY_CAP: "daily-cap-3-per-24h",
});

function parseHHMM(value, name) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) throw new RangeError(`user.quietHours.${name} must be "HH:MM", got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes since local midnight in the customer's time zone.
function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

// Window is [start, end) and may wrap midnight. start === end is treated as an empty window.
function inQuietHours(user, now) {
  if (!user.quietHours) return false;
  const start = parseHHMM(user.quietHours.start, "start");
  const end = parseHHMM(user.quietHours.end, "end");
  if (start === end) return false;
  const minutes = localMinutes(now, user.timeZone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const nowMs = now.getTime();
  const quiet = inQuietHours(user, now);

  // Unparseable sentAt is treated as "just now": it blocks duplicates and counts toward the cap.
  const sent = history.map((h) => {
    const t = Date.parse(h.sentAt);
    return { ms: Number.isNaN(t) ? nowMs : t, category: h.category, dedupeKey: h.dedupeKey };
  });
  const recentKeys = new Set(sent.filter((h) => h.ms > nowMs - DEDUPE_WINDOW_MS).map((h) => h.dedupeKey));
  const capUsed = sent.filter(
    (h) => h.ms > nowMs - DAY_MS && (h.category === "reminder" || h.category === "promo"),
  ).length;
  let capLeft = Math.max(0, DAILY_CAP - capUsed);

  // Best first; ties keep input order (Array#sort is stable). Non-finite priorities sort last.
  const rank = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  const ordered = [...candidates].sort((a, b) => rank(b) - rank(a));

  const send = [];
  const heldBy = new Map();
  const batchKeys = new Set();

  for (const c of ordered) {
    let rule = null;
    if (!CATEGORIES.has(c.category)) rule = RULES.INVALID_CATEGORY;
    else if (!Number.isFinite(c.priority)) rule = RULES.INVALID_PRIORITY;
    else if (c.category === "promo" && user.promoOptIn !== true) rule = RULES.NO_PROMO_OPT_IN;
    // Critical alerts (fraud, account security) are transactional: they ignore quiet hours and the cap.
    else if (quiet && c.category !== "critical") rule = RULES.QUIET_HOURS;
    else if (recentKeys.has(c.dedupeKey)) rule = RULES.RECENT_DUPLICATE;
    else if (batchKeys.has(c.dedupeKey)) rule = RULES.BATCH_DUPLICATE;
    else if (c.category !== "critical" && capLeft === 0) rule = RULES.DAILY_CAP;

    if (rule) {
      heldBy.set(c, rule);
      continue;
    }
    if (c.category !== "critical") capLeft -= 1;
    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  const dropped = candidates.filter((c) => heldBy.has(c)).map((c) => ({ id: c.id, rule: heldBy.get(c) }));
  return { send, dropped };
}
