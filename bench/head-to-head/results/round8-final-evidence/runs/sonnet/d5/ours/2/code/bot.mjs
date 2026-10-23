// Pure send planner: no clock, no file access, no mutation of arguments.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CAP_PER_24H = 3;
const DEDUPE_MS = 7 * DAY_MS;

// Minutes since local midnight in `timeZone`, or null when the zone is invalid.
function localMinutes(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

function parseHHMM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

// Window includes its start minute, excludes its end minute, wraps past midnight.
// start === end is an empty window.
function inWindow(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid Date');

  const dropped = [];
  const send = [];

  // Quiet-hours state, computed once. null = no quiet hours apply.
  let quiet = 'none'; // 'none' | 'in' | 'bad-zone' | 'bad-window'
  const qh = user?.quietHours;
  if (qh) {
    const minutes = localMinutes(nowMs, user.timeZone);
    const s = parseHHMM(qh.start);
    const e = parseHHMM(qh.end);
    if (minutes === null) quiet = 'bad-zone';
    else if (s === null || e === null) quiet = 'bad-window';
    else if (inWindow(minutes, s, e)) quiet = 'in';
  }

  const hist = Array.isArray(history) ? history : [];
  const recent = (h, spanMs) => {
    const t = Date.parse(h?.sentAt);
    // Unparseable timestamp: assume recent (conservative).
    return Number.isNaN(t) ? true : t > nowMs - spanMs;
  };
  const sentKeys = new Set(hist.filter((h) => recent(h, DEDUPE_MS)).map((h) => h.dedupeKey));
  const used = hist.filter(
    (h) => (h?.category === 'promo' || h?.category === 'reminder') && recent(h, DAY_MS),
  ).length;

  const pri = (c) => (Number.isFinite(c.priority) ? c.priority : -Infinity);
  const rank = (c) => (c.category === 'critical' ? 1 : 0);
  const order = new Map();
  const list = Array.isArray(candidates) ? candidates : [];
  list.forEach((c, i) => order.set(c, i));
  const sorted = [...list].sort(
    (a, b) => rank(b) - rank(a) || pri(b) - pri(a) || order.get(a) - order.get(b),
  );

  const reasons = new Map(); // candidate -> rule
  const claimedKeys = new Set();
  let remaining = Math.max(0, CAP_PER_24H - used);

  for (const c of sorted) {
    let rule = null;
    if (c.category !== 'promo' && c.category !== 'reminder' && c.category !== 'critical') {
      rule = 'unknown-category';
    } else if (c.category === 'promo' && user?.promoOptIn !== true) {
      rule = 'promo-no-opt-in';
    } else if (c.category !== 'critical' && quiet === 'in') {
      rule = 'quiet-hours';
    } else if (c.category !== 'critical' && quiet === 'bad-zone') {
      rule = 'invalid-time-zone';
    } else if (c.category !== 'critical' && quiet === 'bad-window') {
      rule = 'invalid-quiet-hours';
    } else if (sentKeys.has(c.dedupeKey)) {
      rule = 'dedupe-7d';
    } else if (claimedKeys.has(c.dedupeKey)) {
      rule = 'duplicate-in-batch';
    } else if (c.category !== 'critical') {
      if (remaining <= 0) rule = 'rolling-24h-cap';
      else remaining -= 1;
    }
    if (rule) reasons.set(c, rule);
    else {
      claimedKeys.add(c.dedupeKey);
      send.push(c.id);
    }
  }

  for (const c of list) {
    if (reasons.has(c)) dropped.push({ id: c.id, rule: reasons.get(c) });
  }
  return { send, dropped };
}
