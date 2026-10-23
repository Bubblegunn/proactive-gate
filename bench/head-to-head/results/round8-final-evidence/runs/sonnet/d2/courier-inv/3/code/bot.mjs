import { randomUUID } from 'node:crypto';

const MAX_PROMOS_PER_DAY = 3;
const MIN_PROMO_GAP_MS = 2 * 60 * 60 * 1000;
// Longest local day is 25h and zones differ by up to 26h, so 72h of history is enough to decide any rule.
const KEEP_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

// Returns a formatter for the zone, or null if the zone name is not valid.
function formatterFor(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  let f = formatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      f = null;
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function dayKey(formatter, ms) {
  let y = '', m = '', d = '';
  for (const p of formatter.formatToParts(ms)) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y}-${m}-${d}`;
}

export function createGate() {
  // userId -> array of { id, t } for promos that were allowed (and not cancelled)
  const promosByUser = new Map();
  // id -> userId, for cancel
  const owners = new Map();

  function deny(rule) {
    return { allowed: false, rule, id: null };
  }

  function request({ userId, timeZone, category, now } = {}) {
    // Security alerts are never limited by the promo policy and do not count toward it.
    if (category === 'security') {
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny('invalid-category');

    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(nowMs)) return deny('invalid-time');
    if (typeof userId !== 'string' || userId === '') return deny('invalid-user');
    const fmt = formatterFor(timeZone);
    if (fmt === null) return deny('invalid-time-zone');

    let list = promosByUser.get(userId);
    if (list === undefined) {
      list = [];
      promosByUser.set(userId, list);
    }

    // Drop old entries.
    const kept = [];
    for (const rec of list) {
      if (rec.t >= nowMs - KEEP_MS) kept.push(rec);
      else owners.delete(rec.id);
    }
    list = kept;
    promosByUser.set(userId, list);

    const today = dayKey(fmt, nowMs);
    let countToday = 0;
    let tooClose = false;
    for (const rec of list) {
      if (dayKey(fmt, rec.t) === today) countToday++;
      if (Math.abs(nowMs - rec.t) < MIN_PROMO_GAP_MS) tooClose = true;
    }

    if (countToday >= MAX_PROMOS_PER_DAY) return deny('daily-cap');
    if (tooClose) return deny('min-gap');

    // The caller sends right away, so record the send now.
    const id = randomUUID();
    list.push({ id, t: nowMs });
    owners.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return; // unknown, security, already cancelled, or expired
    owners.delete(id);
    const list = promosByUser.get(userId);
    if (list === undefined) return;
    const i = list.findIndex((rec) => rec.id === id);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) promosByUser.delete(userId);
  }

  return { request, cancel };
}
