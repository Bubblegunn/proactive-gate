// Pure send planner. Reads no clock and no file, and does not mutate its arguments.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const CAP_PER_24H = 3;
const CAPPED = new Set(['promo', 'reminder']);

function parseHHMM(value, label) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) throw new RangeError(`${label} must be "HH:MM", got ${JSON.stringify(value)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Minutes since local midnight in the given IANA time zone.
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get('hour') % 24) * 60 + get('minute');
}

// Window may wrap midnight (e.g. 22:00-07:00). Start inclusive, end exclusive.
// start === end is treated as an empty window (no quiet hours).
function inQuietHours(user, now) {
  const q = user.quietHours;
  if (!q) return false;
  const start = parseHHMM(q.start, 'quietHours.start');
  const end = parseHHMM(q.end, 'quietHours.end');
  if (start === end) return false;
  const t = localMinutes(now, user.timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

function toMs(sentAt) {
  const ms = Date.parse(sentAt);
  if (Number.isNaN(ms)) throw new RangeError(`history.sentAt is not a valid timestamp: ${JSON.stringify(sentAt)}`);
  return ms;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError('now is an invalid Date');

  const entries = history.map((h) => ({ ms: toMs(h.sentAt), category: h.category, dedupeKey: h.dedupeKey }));

  const recentKeys = new Set(
    entries.filter((h) => h.ms > nowMs - DEDUPE_WINDOW_MS).map((h) => h.dedupeKey),
  );
  const usedInWindow = entries.filter((h) => CAPPED.has(h.category) && h.ms > nowMs - DAY_MS).length;
  let slots = Math.max(0, CAP_PER_24H - usedInWindow);

  const quiet = inQuietHours(user, now);

  const dropped = new Map(); // id -> rule, keyed by candidate index to keep input order
  const drop = (c, rule) => dropped.set(c, rule);

  // Per-candidate rules. Critical messages are exempt from opt-in, quiet hours and the cap.
  const eligible = [];
  for (const c of candidates) {
    if (c.category !== 'promo' && c.category !== 'reminder' && c.category !== 'critical') {
      drop(c, 'unknown-category');
    } else if (c.category === 'promo' && user.promoOptIn !== true) {
      drop(c, 'promo-no-opt-in');
    } else if (c.category !== 'critical' && quiet) {
      drop(c, 'quiet-hours');
    } else if (recentKeys.has(c.dedupeKey)) {
      drop(c, 'dedupe-7d');
    } else {
      eligible.push(c);
    }
  }

  // Best first; ties keep input order (Array.prototype.sort is stable).
  const ranked = eligible.slice().sort((a, b) => b.priority - a.priority);

  const send = [];
  const seenKeys = new Set();
  for (const c of ranked) {
    if (seenKeys.has(c.dedupeKey)) {
      drop(c, 'dedupe-in-batch');
      continue;
    }
    if (c.category !== 'critical') {
      if (slots <= 0) {
        drop(c, 'rolling-24h-cap');
        continue;
      }
      slots--;
    }
    seenKeys.add(c.dedupeKey);
    send.push(c.id);
  }

  return {
    send,
    dropped: candidates.filter((c) => dropped.has(c)).map((c) => ({ id: c.id, rule: dropped.get(c) })),
  };
}
