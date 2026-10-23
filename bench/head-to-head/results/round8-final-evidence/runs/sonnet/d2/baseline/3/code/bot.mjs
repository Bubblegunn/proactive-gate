// Push gate. Promo rules: max 3 per customer per local calendar day,
// and at least 2 hours between two promos to the same customer.
// Security pushes are transactional: always allowed, never counted.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
// A local day is at most 25 hours long, so older sends can never matter.
const KEEP_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

// Calendar date of `ms` in `timeZone`, as "YYYY-MM-DD". Throws RangeError on a bad zone.
function localDay(ms, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
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
  const promosByUser = new Map(); // userId -> [{ id, t }]
  const promoById = new Map(); // id -> { userId, t }
  let seq = 0;

  const newId = (prefix) => `${prefix}-${++seq}`;

  function prune(userId, list, nowMs) {
    const kept = [];
    for (const rec of list) {
      if (nowMs - rec.t > KEEP_MS) promoById.delete(rec.id);
      else kept.push(rec);
    }
    if (kept.length === 0) promosByUser.delete(userId);
    else promosByUser.set(userId, kept);
    return kept;
  }

  function request({ userId, timeZone, category, now } = {}) {
    if (category === 'security') {
      return { allowed: true, rule: '', id: newId('sec') };
    }
    if (category !== 'promo') {
      return { allowed: false, rule: 'invalid-category', id: null };
    }
    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (Number.isNaN(nowMs)) {
      return { allowed: false, rule: 'invalid-time', id: null };
    }
    let today;
    try {
      today = localDay(nowMs, timeZone);
    } catch {
      return { allowed: false, rule: 'invalid-time-zone', id: null };
    }

    const list = prune(userId, promosByUser.get(userId) ?? [], nowMs);

    for (const rec of list) {
      if (Math.abs(nowMs - rec.t) < MIN_GAP_MS) {
        return { allowed: false, rule: 'min-gap', id: null };
      }
    }
    let count = 0;
    for (const rec of list) {
      if (localDay(rec.t, timeZone) === today) count++;
    }
    if (count >= MAX_PROMOS_PER_DAY) {
      return { allowed: false, rule: 'daily-cap', id: null };
    }

    // Allowed: caller sends now, so record it now.
    const id = newId('promo');
    const rec = { id, t: nowMs };
    list.push(rec);
    promosByUser.set(userId, list);
    promoById.set(id, { userId });
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const info = promoById.get(id);
    if (!info) return; // unknown, security, pruned, or already cancelled
    promoById.delete(id);
    const list = promosByUser.get(info.userId);
    if (!list) return;
    const kept = list.filter((rec) => rec.id !== id);
    if (kept.length === 0) promosByUser.delete(info.userId);
    else promosByUser.set(info.userId, kept);
  }

  return { request, cancel };
}
