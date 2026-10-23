// Decides which candidate messages may go out now. Pure: no clock, no I/O, no mutation of arguments.

const MAX_PER_24H = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const CATEGORIES = new Set(["promo", "reminder", "critical"]);

export const RULES = Object.freeze({
  invalidCandidate: "invalid-candidate",
  invalidUserConfig: "invalid-user-config",
  noPromoConsent: "promo-not-opted-in",
  quietHours: "quiet-hours",
  dedupeHistory: "duplicate-within-7d",
  dedupeBatch: "duplicate-in-batch",
  dailyCap: "daily-cap",
});

function parseHHMM(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Minutes since local midnight in `timeZone`. Throws RangeError on an unknown zone.
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

// Returns true / false, or null when the user's time settings are unusable.
// The window is [start, end) and may wrap past midnight. start === end means no window.
function inQuietHours(user, now) {
  const qh = user.quietHours;
  if (qh == null) return false;
  const start = parseHHMM(qh.start);
  const end = parseHHMM(qh.end);
  if (start === null || end === null) return null;
  if (start === end) return false;
  let local;
  try {
    local = localMinutes(now, user.timeZone);
  } catch {
    return null;
  }
  return start < end ? local >= start && local < end : local >= start || local < end;
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const nowMs = now.getTime();

  // Parse history once. Entries with an unparseable timestamp cannot be placed in time and are ignored.
  const past = [];
  for (const h of history ?? []) {
    const t = Date.parse(h.sentAt);
    if (!Number.isNaN(t)) past.push({ t, category: h.category, dedupeKey: h.dedupeKey });
  }
  const recentKeys = new Set(past.filter((h) => h.t > nowMs - DEDUPE_MS).map((h) => h.dedupeKey));
  const capUsed = past.filter(
    (h) => (h.category === "promo" || h.category === "reminder") && h.t > nowMs - DAY_MS,
  ).length;
  let capLeft = Math.max(0, MAX_PER_24H - capUsed);

  const quiet = inQuietHours(user, now);
  const dropped = [];
  const send = [];

  // Best first: higher priority first, input order breaks ties. Copy, so the argument is not reordered.
  const ordered = [...candidates]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = Number.isFinite(a.c.priority) ? a.c.priority : -Infinity;
      const pb = Number.isFinite(b.c.priority) ? b.c.priority : -Infinity;
      return pb - pa || a.i - b.i;
    })
    .map((x) => x.c);

  const acceptedKeys = new Set();
  for (const c of ordered) {
    const drop = (rule) => dropped.push({ id: c.id, rule });

    if (!CATEGORIES.has(c.category) || !Number.isFinite(c.priority) || typeof c.dedupeKey !== "string") {
      drop(RULES.invalidCandidate);
      continue;
    }
    const critical = c.category === "critical";

    // Critical (fraud, account security) is transactional: it skips consent, quiet hours and the cap.
    if (!critical) {
      // Apple App Store Review Guideline 4.5.4: no promotional push without explicit opt-in.
      if (c.category === "promo" && user.promoOptIn !== true) {
        drop(RULES.noPromoConsent);
        continue;
      }
      if (quiet === null) {
        drop(RULES.invalidUserConfig);
        continue;
      }
      if (quiet) {
        drop(RULES.quietHours);
        continue;
      }
    }
    if (recentKeys.has(c.dedupeKey)) {
      drop(RULES.dedupeHistory);
      continue;
    }
    if (acceptedKeys.has(c.dedupeKey)) {
      drop(RULES.dedupeBatch);
      continue;
    }
    if (!critical) {
      if (capLeft === 0) {
        drop(RULES.dailyCap);
        continue;
      }
      capLeft -= 1;
    }
    acceptedKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return { send, dropped };
}
