import { randomUUID } from 'node:crypto';

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

// Returns a formatter for the zone, or null if the zone name is invalid.
function formatterFor(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    f = null;
  }
  formatters.set(timeZone, f);
  return f;
}

// Calendar day (midnight to midnight) of the instant in the given zone.
function dayKey(formatter, ms) {
  const p = formatter.formatToParts(new Date(ms));
  let y = '', m = '', d = '';
  for (const part of p) {
    if (part.type === 'year') y = part.value;
    else if (part.type === 'month') m = part.value;
    else if (part.type === 'day') d = part.value;
  }
  return `${y}-${m}-${d}`;
}

export function createGate() {
  // userId -> Map(id -> sendTimeMs), promos only
  const promos = new Map();
  // id -> userId, for cancel
  const owners = new Map();

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function request({ userId, timeZone, category, now } = {}) {
    if (category !== 'promo' && category !== 'security') return deny('invalid-category');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid-time');
    const nowMs = now.getTime();

    if (category === 'security') {
      // Security alerts are never limited by promo policy and do not count toward it.
      return { allowed: true, rule: '', id: randomUUID() };
    }

    if (typeof userId !== 'string' || userId === '') return deny('invalid-user');
    const fmt = formatterFor(timeZone);
    if (!fmt) return deny('invalid-time-zone');

    let sends = promos.get(userId);
    if (!sends) {
      sends = new Map();
      promos.set(userId, sends);
    }

    // Drop old records so memory stays bounded.
    for (const [id, t] of sends) {
      if (t < nowMs - KEEP_MS) {
        sends.delete(id);
        owners.delete(id);
      }
    }

    let sameDay = 0;
    let tooClose = false;
    const today = dayKey(fmt, nowMs);
    for (const t of sends.values()) {
      if (Math.abs(nowMs - t) < MIN_GAP_MS) tooClose = true;
      if (dayKey(fmt, t) === today) sameDay++;
    }

    if (tooClose) return deny('min-gap');
    if (sameDay >= MAX_PROMOS_PER_DAY) return deny('daily-cap');

    const id = randomUUID();
    sends.set(id, nowMs);
    owners.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return;
    owners.delete(id);
    const sends = promos.get(userId);
    if (sends) {
      sends.delete(id);
      if (sends.size === 0) promos.delete(userId);
    }
  }

  return { request, cancel };
}
