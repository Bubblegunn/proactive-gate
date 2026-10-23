// Pure send planner. No clock, no file access, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CAP_WINDOW_MS = DAY_MS;
const CAP_MAX = 3;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;

const CATEGORIES = new Set(["promo", "reminder", "critical"]);

export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: "unknown-category",
  PROMO_NOT_OPTED_IN: "promo-not-opted-in",
  QUIET_HOURS: "quiet-hours",
  DEDUPE_RECENT: "dedupe-7d",
  DEDUPE_BATCH: "dedupe-in-batch",
  DAILY_CAP: "daily-cap",
});

function parseClock(value, name) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!m) throw new TypeError(`user.quietHours.${name} must be "HH:MM" (00:00-23:59), got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function localMinutesOfDay(date, timeZone) {
  // Throws RangeError for an invalid IANA name.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get("hour") % 24) * 60 + get("minute");
}

// Window is [start, end). It may wrap past midnight (22:00-07:00).
// start === end is treated as an empty window (no quiet hours).
function inQuietHours(user, now) {
  const q = user.quietHours;
  if (!q) return false;
  const start = parseClock(q.start, "start");
  const end = parseClock(q.end, "end");
  if (start === end) return false;
  const m = localMinutesOfDay(now, user.timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

function parseHistory(history, nowMs) {
  return history.map((h) => {
    const t = Date.parse(h.sentAt);
    if (Number.isNaN(t)) throw new TypeError(`history entry has invalid sentAt: ${JSON.stringify(h.sentAt)}`);
    return { t, age: nowMs - t, category: h.category, dedupeKey: h.dedupeKey };
  });
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError("now must be a valid Date");

  const past = parseHistory(history, nowMs);
  // Entries dated in the future (clock skew) count as recent: err on the side of sending less.
  const recentKeys = new Set(past.filter((h) => h.age < DEDUPE_WINDOW_MS).map((h) => h.dedupeKey));
  const capUsed = past.filter(
    (h) => h.age < CAP_WINDOW_MS && (h.category === "promo" || h.category === "reminder"),
  ).length;

  const quiet = inQuietHours(user, now);
  const dropped = new Map(); // candidate -> rule

  // Stage 1: per-candidate eligibility.
  const eligible = [];
  for (const c of candidates) {
    let rule = null;
    if (!CATEGORIES.has(c.category)) rule = RULES.UNKNOWN_CATEGORY;
    else if (c.category === "promo" && !user.promoOptIn) rule = RULES.PROMO_NOT_OPTED_IN;
    else if (c.category !== "critical" && quiet) rule = RULES.QUIET_HOURS;
    else if (recentKeys.has(c.dedupeKey)) rule = RULES.DEDUPE_RECENT;
    if (rule) dropped.set(c, rule);
    else eligible.push(c);
  }

  // Stage 2: rank. Critical first, then higher priority, then input order.
  const prio = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  const order = new Map(candidates.map((c, i) => [c, i]));
  const ranked = [...eligible].sort(
    (a, b) =>
      (b.category === "critical") - (a.category === "critical") ||
      (prio(b) > prio(a) ? 1 : prio(b) < prio(a) ? -1 : 0) ||
      order.get(a) - order.get(b),
  );

  // Stage 3: one message per dedupeKey in this batch, then the rolling 24h cap.
  // Critical messages are exempt from the cap and do not consume it.
  const seenKeys = new Set();
  const send = [];
  let capLeft = Math.max(0, CAP_MAX - capUsed);
  for (const c of ranked) {
    if (seenKeys.has(c.dedupeKey)) {
      dropped.set(c, RULES.DEDUPE_BATCH);
      continue;
    }
    seenKeys.add(c.dedupeKey);
    if (c.category !== "critical") {
      if (capLeft === 0) {
        dropped.set(c, RULES.DAILY_CAP);
        continue;
      }
      capLeft--;
    }
    send.push(c.id);
  }

  return {
    send,
    dropped: candidates.filter((c) => dropped.has(c)).map((c) => ({ id: c.id, rule: dropped.get(c) })),
  };
}
