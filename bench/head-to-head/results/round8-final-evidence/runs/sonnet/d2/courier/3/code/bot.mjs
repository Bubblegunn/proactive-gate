import { randomUUID } from 'node:crypto';

const MAX_PROMOS_PER_DAY = 3;
const MIN_PROMO_GAP_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

// Returns "YYYY-MM-DD" for the instant `ms` in the given IANA zone. Throws RangeError for an unknown zone.
function localDay(ms, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      calendar: 'gregory',
      numberingSystem: 'latn',
    });
    formatters.set(timeZone, fmt);
  }
  let y = '', m = '', d = '';
  for (const p of fmt.formatToParts(ms)) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y}-${m}-${d}`;
}

export function createGate() {
  // userId -> array of { id, ts } for promos that were allowed (and not cancelled)
  const promosByUser = new Map();
  // id -> userId, for cancel
  const owners = new Map();

  function deny(rule) {
    return { allowed: false, rule, id: null };
  }

  function request({ userId, timeZone, category, now }) {
    // Security alerts are transactional: never limited, never counted against promo limits.
    if (category === 'security') {
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny('unknown-category');

    const ts = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(ts)) return deny('invalid-time');

    let today;
    try {
      today = localDay(ts, timeZone);
    } catch {
      return deny('invalid-time-zone');
    }

    let list = promosByUser.get(userId);
    if (!list) {
      list = [];
      promosByUser.set(userId, list);
    }

    // Drop records far in the past to keep memory bounded.
    const newest = Math.max(ts, ...list.map((e) => e.ts));
    if (list.length && list[0].ts < newest - RETENTION_MS) {
      const kept = [];
      for (const e of list) {
        if (e.ts >= newest - RETENTION_MS) kept.push(e);
        else owners.delete(e.id);
      }
      list = kept;
      promosByUser.set(userId, list);
    }

    let sameDay = 0;
    for (const e of list) {
      if (localDay(e.ts, timeZone) === today) sameDay++;
    }
    if (sameDay >= MAX_PROMOS_PER_DAY) return deny('daily-cap');

    for (const e of list) {
      if (Math.abs(e.ts - ts) < MIN_PROMO_GAP_MS) return deny('min-gap');
    }

    const id = randomUUID();
    list.push({ id, ts });
    list.sort((a, b) => a.ts - b.ts);
    owners.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return;
    owners.delete(id);
    const list = promosByUser.get(userId);
    if (!list) return;
    const i = list.findIndex((e) => e.id === id);
    if (i !== -1) list.splice(i, 1);
  }

  return { request, cancel };
}
