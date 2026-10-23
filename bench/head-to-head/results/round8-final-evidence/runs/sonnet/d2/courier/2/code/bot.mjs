// Promo gate: max 3 promos per customer per local calendar day, and at least
// 2 hours between two promos to the same customer. Security pushes are never
// limited and never counted. State is in memory (single process).

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
// Records older than this cannot affect a decision: a local day is at most
// ~25h long and the gap is 2h.
const RETAIN_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

function localDay(timeZone, ms) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f.format(ms); // e.g. "2026-10-23"
}

export function createGate() {
  const promosByUser = new Map(); // userId -> [{ id, t }]
  const owner = new Map(); // id -> userId (promo ids only)
  let seq = 0;

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function request({ userId, timeZone, category, now }) {
    if (category === 'security') {
      return { allowed: true, rule: '', id: `s${++seq}` };
    }
    if (category !== 'promo') return deny('unknown-category');

    const ms = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(ms)) return deny('invalid-time');

    let today;
    try {
      today = localDay(timeZone, ms);
    } catch {
      return deny('invalid-time-zone');
    }

    let list = promosByUser.get(userId);
    if (list) {
      list = list.filter((r) => {
        if (r.t >= ms - RETAIN_MS) return true;
        owner.delete(r.id);
        return false;
      });
      promosByUser.set(userId, list);
    } else {
      list = [];
      promosByUser.set(userId, list);
    }

    // Day is judged in the timezone given on this request.
    let count = 0;
    for (const r of list) if (localDay(timeZone, r.t) === today) count++;
    if (count >= MAX_PROMOS_PER_DAY) return deny('daily-cap');

    for (const r of list) {
      if (Math.abs(ms - r.t) < MIN_GAP_MS) return deny('min-gap');
    }

    const id = `p${++seq}`;
    list.push({ id, t: ms });
    owner.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owner.get(id);
    if (userId === undefined) return;
    owner.delete(id);
    const list = promosByUser.get(userId);
    if (!list) return;
    const i = list.findIndex((r) => r.id === id);
    if (i !== -1) list.splice(i, 1);
  }

  return { request, cancel };
}
