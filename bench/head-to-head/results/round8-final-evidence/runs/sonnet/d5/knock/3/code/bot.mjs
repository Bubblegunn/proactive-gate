// Pure send planner. No clock, no file access, no argument mutation.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const MAX_PER_24H = 3;

const CATEGORIES = new Set(["promo", "reminder", "critical"]);

// Rule identifiers returned in `dropped[].rule`.
export const RULES = Object.freeze({
  UNKNOWN_CATEGORY: "unknown-category",
  NO_PROMO_OPT_IN: "promo-no-opt-in",
  DEDUPE_HISTORY: "dedupe-7d",
  DEDUPE_BATCH: "dedupe-same-batch",
  QUIET_HOURS: "quiet-hours",
  QUIET_HOURS_UNKNOWN: "quiet-hours-unevaluable",
  RATE_LIMIT: "rate-limit-24h",
});

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === "string" ? s.trim() : "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes since local midnight in `timeZone` at instant `date`, or null if the zone is invalid.
function localMinutes(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === "hour").value);
    const m = Number(parts.find((p) => p.type === "minute").value);
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

// "ok" | "quiet" | "unknown". Window is [start, end), may wrap midnight.
// start === end is treated as an empty window (no quiet hours).
function quietState(user, now) {
  const q = user?.quietHours;
  if (q == null) return "ok";
  const start = parseHHMM(q.start);
  const end = parseHHMM(q.end);
  if (start === null || end === null) return "unknown";
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "unknown";
  const cur = localMinutes(now, user.timeZone);
  if (cur === null) return "unknown";
  if (start === end) return "ok";
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  return inside ? "quiet" : "ok";
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  const quiet = quietState(user, now);

  // Parse history once. Unparseable or future timestamps are treated as "just now" (fail closed).
  const hist = (history ?? []).map((h) => {
    let t = Date.parse(h.sentAt);
    if (Number.isNaN(t) || t > nowMs) t = nowMs;
    return { t, category: h.category, dedupeKey: h.dedupeKey };
  });

  const recentKeys = new Set(
    hist.filter((h) => nowMs - h.t < DEDUPE_MS).map((h) => h.dedupeKey),
  );
  let capUsed = hist.filter(
    (h) => h.category !== "critical" && nowMs - h.t < DAY_MS,
  ).length;

  const prio = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  const ordered = (candidates ?? [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ca = a.c.category === "critical" ? 0 : 1;
      const cb = b.c.category === "critical" ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const pa = prio(a.c);
      const pb = prio(b.c);
      if (pa !== pb) return pb > pa ? 1 : -1;
      return a.i - b.i;
    });

  const send = [];
  const dropped = [];
  const batchKeys = new Set();

  for (const { c } of ordered) {
    const drop = (rule) => dropped.push({ id: c.id, rule });

    if (!CATEGORIES.has(c.category)) { drop(RULES.UNKNOWN_CATEGORY); continue; }
    if (c.category === "promo" && user?.promoOptIn !== true) { drop(RULES.NO_PROMO_OPT_IN); continue; }
    if (recentKeys.has(c.dedupeKey)) { drop(RULES.DEDUPE_HISTORY); continue; }
    if (batchKeys.has(c.dedupeKey)) { drop(RULES.DEDUPE_BATCH); continue; }

    if (c.category !== "critical") {
      // Critical alerts (fraud / account security) bypass quiet hours and the cap, and do not count toward it.
      if (quiet === "quiet") { drop(RULES.QUIET_HOURS); continue; }
      if (quiet === "unknown") { drop(RULES.QUIET_HOURS_UNKNOWN); continue; }
      if (capUsed >= MAX_PER_24H) { drop(RULES.RATE_LIMIT); continue; }
      capUsed++;
    }

    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return { send, dropped };
}
