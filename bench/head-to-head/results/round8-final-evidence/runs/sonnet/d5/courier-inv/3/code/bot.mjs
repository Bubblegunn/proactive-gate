// Send planner for the habit-tracking assistant. Pure: no clock, no file access,
// and the arguments are never modified.
//
// Rules, in the order they are checked for each candidate (first match is the
// reported reason):
//   unknown-category        category is not promo, reminder or critical (fail closed)
//   promo-no-opt-in         promo and user.promoOptIn is not exactly true
//                           (App Store Review Guideline 4.5.4: no promotional push
//                           without explicit opt-in)
//   quiet-hours             promo or reminder inside the customer's quiet hours
//   quiet-hours-unreadable  quiet hours or time zone cannot be evaluated (fail closed)
//   dedupe-7d               same dedupeKey already sent in the last 7 days
//   duplicate-in-batch      same dedupeKey as a better candidate in this batch
//   rate-limit-24h          promo and reminder together would exceed 3 in a rolling 24 hours
//
// Critical messages (fraud, account security) skip the opt-in, quiet-hours and
// rate-limit rules and do not count toward the 3-per-24-hours limit. They still
// obey the 7-day dedupeKey rule, which prevents repeats of the same alert.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const MAX_PER_24H = 3;
const CATEGORIES = new Set(["promo", "reminder", "critical"]);

function parseClock(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof value === "string" ? value : "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function localMinutes(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

// Returns "in", "out" or "unreadable". The start is inclusive and the end is
// exclusive. A window with start after end crosses midnight. start === end is
// an empty window.
function quietState(user, now) {
  const qh = user?.quietHours;
  if (qh == null) return "out";
  const start = parseClock(qh.start);
  const end = parseClock(qh.end);
  if (start === null || end === null) return "unreadable";
  if (start === end) return "out";
  let minutes;
  try {
    minutes = localMinutes(user.timeZone, now);
  } catch {
    return "unreadable";
  }
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return inside ? "in" : "out";
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const nowMs = now.getTime();
  const quiet = quietState(user, now);

  // An unparseable sentAt counts as just sent, so it can only make us send less.
  const sentMs = (h) => {
    const t = Date.parse(h?.sentAt);
    return Number.isNaN(t) ? nowMs : t;
  };
  const recentKeys = new Set();
  let capUsed = 0;
  for (const h of history ?? []) {
    const t = sentMs(h);
    if (t > nowMs - DEDUPE_MS) recentKeys.add(h.dedupeKey);
    if ((h.category === "promo" || h.category === "reminder") && t > nowMs - DAY_MS) capUsed++;
  }

  const dropped = [];
  const eligible = [];
  (candidates ?? []).forEach((c, index) => {
    const drop = (rule) => dropped.push({ id: c.id, rule });
    if (!CATEGORIES.has(c.category)) return drop("unknown-category");
    if (c.category !== "critical") {
      if (c.category === "promo" && user?.promoOptIn !== true) return drop("promo-no-opt-in");
      if (quiet === "in") return drop("quiet-hours");
      if (quiet === "unreadable") return drop("quiet-hours-unreadable");
    }
    if (recentKeys.has(c.dedupeKey)) return drop("dedupe-7d");
    eligible.push({ c, index });
  });

  // Best first: higher priority, then critical before the rest, then input order.
  const priorityOf = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  eligible.sort(
    (a, b) =>
      priorityOf(b.c) - priorityOf(a.c) ||
      (b.c.category === "critical") - (a.c.category === "critical") ||
      a.index - b.index
  );

  const send = [];
  const seenKeys = new Set();
  let capLeft = Math.max(0, MAX_PER_24H - capUsed);
  const lateDrops = [];
  for (const { c, index } of eligible) {
    if (seenKeys.has(c.dedupeKey)) {
      lateDrops.push({ index, id: c.id, rule: "duplicate-in-batch" });
      continue;
    }
    if (c.category !== "critical") {
      if (capLeft === 0) {
        lateDrops.push({ index, id: c.id, rule: "rate-limit-24h" });
        continue;
      }
      capLeft--;
    }
    seenKeys.add(c.dedupeKey);
    send.push(c.id);
  }
  lateDrops.sort((a, b) => a.index - b.index);
  for (const { id, rule } of lateDrops) dropped.push({ id, rule });

  return { send, dropped };
}
