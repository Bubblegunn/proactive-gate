// Pure send gate for the habit-tracking assistant. No clock, no I/O, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const CAP_WINDOW_MS = DAY_MS;
const MAX_CAPPED_PER_WINDOW = 3;

const CATEGORIES = new Set(["promo", "reminder", "critical"]);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const RULES = Object.freeze({
  invalidCandidate: "invalid-candidate",
  noPromoConsent: "promo-no-opt-in",
  invalidTimeZone: "invalid-time-zone",
  invalidQuietHours: "invalid-quiet-hours",
  quietHours: "quiet-hours",
  dedupeHistory: "dedupe-7d",
  dedupeBatch: "dedupe-in-batch",
  dailyCap: "daily-cap-3",
});

function parseHHMM(value) {
  if (typeof value !== "string") return null;
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Minutes since local midnight in `timeZone`, or null if the zone is unknown.
function localMinutes(nowMs, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

// Returns { state: "none" | "inside" | "outside" | "bad-zone" | "bad-window" }.
// start === end is treated as an empty window (no quiet hours).
function quietState(user, nowMs) {
  const q = user?.quietHours;
  if (q == null) return "none";
  const start = parseHHMM(q.start);
  const end = parseHHMM(q.end);
  if (start === null || end === null) return "bad-window";
  if (start === end) return "none";
  const minutes = localMinutes(nowMs, user.timeZone);
  if (minutes === null) return "bad-zone";
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return inside ? "inside" : "outside";
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date");

  const quiet = quietState(user, nowMs);

  // Index history. Entries with an unparseable timestamp cannot be placed in a window and are ignored.
  const recentKeys = new Set();
  let cappedInWindow = 0;
  for (const h of history ?? []) {
    const t = Date.parse(h?.sentAt);
    if (!Number.isFinite(t)) continue;
    if (t > nowMs - DEDUPE_WINDOW_MS) recentKeys.add(h.dedupeKey);
    if (t > nowMs - CAP_WINDOW_MS && (h.category === "promo" || h.category === "reminder")) {
      cappedInWindow += 1;
    }
  }

  // Best first: higher priority wins, input order breaks ties. Copy so the argument is not reordered.
  const ordered = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const pa = Number.isFinite(a.c?.priority) ? a.c.priority : -Infinity;
      const pb = Number.isFinite(b.c?.priority) ? b.c.priority : -Infinity;
      return pb - pa || a.index - b.index;
    });

  const send = [];
  const dropped = [];
  const claimedKeys = new Set();
  const drop = (id, rule) => dropped.push({ id, rule });

  for (const { c } of ordered) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !CATEGORIES.has(c.category) ||
      !Number.isFinite(c.priority) ||
      typeof c.dedupeKey !== "string"
    ) {
      drop(c?.id, RULES.invalidCandidate);
      continue;
    }

    const critical = c.category === "critical";

    // Apple App Store Review Guideline 4.5.4: no promotional push without explicit opt-in.
    // Applied to every promo, in-app or push, since the candidate does not say which channel it uses.
    if (c.category === "promo" && user?.promoOptIn !== true) {
      drop(c.id, RULES.noPromoConsent);
      continue;
    }

    // Critical messages ignore quiet hours and the daily cap.
    if (!critical) {
      if (quiet === "bad-zone") { drop(c.id, RULES.invalidTimeZone); continue; }
      if (quiet === "bad-window") { drop(c.id, RULES.invalidQuietHours); continue; }
      if (quiet === "inside") { drop(c.id, RULES.quietHours); continue; }
    }

    if (recentKeys.has(c.dedupeKey)) { drop(c.id, RULES.dedupeHistory); continue; }
    if (claimedKeys.has(c.dedupeKey)) { drop(c.id, RULES.dedupeBatch); continue; }

    if (!critical && cappedInWindow >= MAX_CAPPED_PER_WINDOW) {
      drop(c.id, RULES.dailyCap);
      continue;
    }

    send.push(c.id);
    claimedKeys.add(c.dedupeKey);
    if (!critical) cappedInWindow += 1;
  }

  return { send, dropped };
}
