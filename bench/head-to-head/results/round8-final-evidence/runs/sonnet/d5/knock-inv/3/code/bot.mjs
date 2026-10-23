// Pure send planner for the habit-tracking assistant.
// No clock, no file access, no mutation of arguments.

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * HOUR_MS;
const DEDUPE_MS = 7 * 24 * HOUR_MS;
const CAP_24H = 3; // reminders + promos together

const CATEGORY_RANK = { critical: 0, reminder: 1, promo: 2 };

// Rule identifiers (one per reason).
export const RULES = Object.freeze({
  INVALID_CANDIDATE: 'invalid-candidate',
  PROMO_NOT_OPTED_IN: 'promo-not-opted-in',
  INVALID_USER_CONFIG: 'invalid-user-config',
  QUIET_HOURS: 'quiet-hours',
  DEDUPE_7_DAYS: 'dedupe-7-days',
  DEDUPE_IN_BATCH: 'dedupe-in-batch',
  CAP_24H: 'cap-3-per-24h',
});

function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Minutes since local midnight in `timeZone`, or null if the zone is invalid.
function localMinutes(timeZone, now) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

// Returns 'in' | 'out' | 'invalid'. Window is [start, end) and may wrap midnight.
// start === end is an empty window (nothing is quiet).
function quietHoursState(user, now) {
  const q = user.quietHours;
  if (q == null) return 'out';
  const start = parseHHMM(q.start);
  const end = parseHHMM(q.end);
  if (start === null || end === null) return 'invalid';
  const minutes = localMinutes(user.timeZone, now);
  if (minutes === null) return 'invalid';
  if (start === end) return 'out';
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return inside ? 'in' : 'out';
}

export function planSends({ user, candidates, history, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const nowMs = now.getTime();

  // Read history. An unparseable sentAt is treated as "just now" (fail closed).
  const sent = history.map((h) => {
    const t = Date.parse(h.sentAt);
    return { ms: Number.isNaN(t) ? nowMs : t, category: h.category, dedupeKey: h.dedupeKey };
  });

  const blockedKeys = new Set(
    sent.filter((h) => nowMs - h.ms < DEDUPE_MS).map((h) => h.dedupeKey),
  );
  const capUsed = sent.filter(
    (h) => (h.category === 'reminder' || h.category === 'promo') && nowMs - h.ms < WINDOW_24H_MS,
  ).length;
  let capLeft = Math.max(0, CAP_24H - capUsed);

  const quiet = quietHoursState(user, now); // only computed once, same for all candidates

  const droppedById = new Map(); // index -> rule
  const eligible = [];

  candidates.forEach((c, index) => {
    const reject = (rule) => droppedById.set(index, rule);
    if (!(c.category in CATEGORY_RANK) || !Number.isFinite(c.priority)) {
      return reject(RULES.INVALID_CANDIDATE);
    }
    // Apple App Store Review Guideline 4.5.4: no promotional push without opt-in.
    if (c.category === 'promo' && user.promoOptIn !== true) return reject(RULES.PROMO_NOT_OPTED_IN);
    // Critical alerts (fraud, account security) ignore quiet hours and the 24h cap.
    if (c.category !== 'critical') {
      if (quiet === 'invalid') return reject(RULES.INVALID_USER_CONFIG);
      if (quiet === 'in') return reject(RULES.QUIET_HOURS);
    }
    if (blockedKeys.has(c.dedupeKey)) return reject(RULES.DEDUPE_7_DAYS);
    eligible.push({ c, index });
  });

  // Best first: priority desc, then critical > reminder > promo, then input order.
  eligible.sort(
    (a, b) =>
      b.c.priority - a.c.priority ||
      CATEGORY_RANK[a.c.category] - CATEGORY_RANK[b.c.category] ||
      a.index - b.index,
  );

  const send = [];
  const claimed = new Set();
  for (const { c, index } of eligible) {
    if (claimed.has(c.dedupeKey)) {
      droppedById.set(index, RULES.DEDUPE_IN_BATCH);
      continue;
    }
    if (c.category !== 'critical') {
      if (capLeft <= 0) {
        droppedById.set(index, RULES.CAP_24H);
        continue;
      }
      capLeft -= 1;
    }
    claimed.add(c.dedupeKey);
    send.push(c.id);
  }

  const dropped = [];
  candidates.forEach((c, index) => {
    if (droppedById.has(index)) dropped.push({ id: c.id, rule: droppedById.get(index) });
  });
  return { send, dropped };
}
