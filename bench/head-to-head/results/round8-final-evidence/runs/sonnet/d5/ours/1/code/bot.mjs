// Pure send planner for the habit-tracking assistant.
// No clock, no file access, no mutation of arguments.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 7 * DAY_MS;
const CAP_PER_24H = 3;

function zoneOk(zone) {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutesOfDay(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function parseHHMM(s) {
  const m = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Window includes its start minute, excludes its end minute; start > end wraps midnight.
// start === end is an empty window.
function inWindow(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(nowMs)) throw new TypeError('now must be a valid Date');

  const send = [];
  const dropped = [];
  const drop = (c, rule) => dropped.push({ id: c.id, rule });

  // Quiet hours state, computed once. Critical messages never use it.
  let quiet = 'none'; // 'none' | 'in' | 'bad-zone' | 'bad-window'
  if (user && user.quietHours) {
    const s = parseHHMM(user.quietHours.start);
    const e = parseHHMM(user.quietHours.end);
    if (s === null || e === null) quiet = 'bad-window';
    else if (!zoneOk(user.timeZone)) quiet = 'bad-zone';
    else if (inWindow(minutesOfDay(nowMs, user.timeZone), s, e)) quiet = 'in';
  } else if (!user || !zoneOk(user.timeZone)) {
    // Without quiet hours the zone is not needed, so a bad zone holds nothing.
  }

  const hist = Array.isArray(history) ? history : [];
  const recentDedupe = new Set();
  let recentCount = 0;
  for (const h of hist) {
    const t = Date.parse(h && h.sentAt);
    if (Number.isNaN(t)) continue;
    if (t > nowMs - DEDUPE_MS) recentDedupe.add(h.dedupeKey);
    // Future-dated entries count too, to stay on the safe side.
    if (t > nowMs - DAY_MS && (h.category === 'promo' || h.category === 'reminder')) recentCount++;
  }
  let slots = Math.max(0, CAP_PER_24H - recentCount);

  const list = Array.isArray(candidates) ? candidates : [];
  const prio = (c) => (typeof c.priority === 'number' && !Number.isNaN(c.priority) ? c.priority : -Infinity);
  const ordered = list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (prio(b.c) === prio(a.c) ? a.i - b.i : prio(b.c) > prio(a.c) ? 1 : -1));

  const batchKeys = new Set();
  for (const { c } of ordered) {
    const cat = c.category;
    if (cat !== 'promo' && cat !== 'reminder' && cat !== 'critical') {
      drop(c, 'unknown-category');
      continue;
    }
    if (cat === 'promo' && user.promoOptIn !== true) {
      drop(c, 'promo-no-opt-in'); // Apple 4.5.4: no promotional push without opt-in
      continue;
    }
    if (cat !== 'critical') {
      if (quiet === 'in') { drop(c, 'quiet-hours'); continue; }
      if (quiet === 'bad-zone') { drop(c, 'invalid-time-zone'); continue; }
      if (quiet === 'bad-window') { drop(c, 'invalid-quiet-hours'); continue; }
    }
    if (recentDedupe.has(c.dedupeKey)) { drop(c, 'dedupe-7d'); continue; }
    if (batchKeys.has(c.dedupeKey)) { drop(c, 'dedupe-same-batch'); continue; }
    if (cat !== 'critical') {
      if (slots <= 0) { drop(c, 'cap-3-per-24h'); continue; }
      slots--;
    }
    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }
  return { send, dropped };
}
