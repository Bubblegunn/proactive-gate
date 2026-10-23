// Pure send planner. No clock, no file access, no argument mutation.

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEDUPE_MS = 7 * DAY_MS;
const CAP_PER_24H = 3;

const formatters = new Map();

function formatterFor(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    fmt = null;
  }
  formatters.set(timeZone, fmt);
  return fmt;
}

function localMinutes(ms, fmt) {
  let h = 0;
  let m = 0;
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type === 'hour') h = Number(p.value) % 24;
    if (p.type === 'minute') m = Number(p.value);
  }
  return h * 60 + m;
}

function parseHHMM(s) {
  const match = typeof s === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Window includes start minute, excludes end minute; start > end wraps midnight.
// start === end is an empty window.
function inWindow(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function planSends({ user, candidates, history, now }) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid Date');

  const fmt = formatterFor(user?.timeZone);
  const quiet = user?.quietHours ?? null;
  let quietState = 'none'; // none | active | inactive | invalid
  if (quiet !== null) {
    const start = parseHHMM(quiet.start);
    const end = parseHHMM(quiet.end);
    if (start === null || end === null || !fmt) {
      quietState = 'invalid';
    } else {
      quietState = inWindow(localMinutes(nowMs, fmt), start, end) ? 'active' : 'inactive';
    }
  }

  // Index history. An unreadable sentAt counts as recent (the safe side).
  const recentKeys = new Set();
  let capUsed = 0;
  for (const h of Array.isArray(history) ? history : []) {
    const t = Date.parse(h?.sentAt);
    const unreadable = !Number.isFinite(t);
    if (unreadable || (t > nowMs - DEDUPE_MS && t <= nowMs)) recentKeys.add(h?.dedupeKey);
    if ((h?.category === 'promo' || h?.category === 'reminder') &&
        (unreadable || (t > nowMs - DAY_MS && t <= nowMs))) {
      capUsed += 1;
    }
  }

  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = Number.isFinite(a.c?.priority) ? a.c.priority : -Infinity;
      const pb = Number.isFinite(b.c?.priority) ? b.c.priority : -Infinity;
      return pa === pb ? a.i - b.i : pb > pa ? 1 : -1;
    });

  const send = [];
  const dropped = [];
  const batchKeys = new Set();
  let slots = Math.max(0, CAP_PER_24H - capUsed);

  for (const { c } of ordered) {
    const drop = (rule) => dropped.push({ id: c?.id, rule });
    const category = c?.category;
    if (category !== 'promo' && category !== 'reminder' && category !== 'critical') {
      drop('unknown-category');
      continue;
    }
    if (recentKeys.has(c.dedupeKey)) { drop('dedupe-7d'); continue; }
    if (category === 'promo' && user?.promoOptIn !== true) { drop('promo-no-opt-in'); continue; }
    if (category !== 'critical') {
      if (!fmt) { drop('invalid-time-zone'); continue; }
      if (quietState === 'invalid') { drop('invalid-quiet-hours'); continue; }
      if (quietState === 'active') { drop('quiet-hours'); continue; }
    }
    if (batchKeys.has(c.dedupeKey)) { drop('dedupe-same-batch'); continue; }
    if (category !== 'critical') {
      if (slots <= 0) { drop('cap-3-per-24h'); continue; }
      slots -= 1;
    }
    batchKeys.add(c.dedupeKey);
    send.push(c.id);
  }
  return { send, dropped };
}
