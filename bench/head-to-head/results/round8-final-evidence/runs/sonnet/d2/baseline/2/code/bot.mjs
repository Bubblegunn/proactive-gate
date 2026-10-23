// Push-notification gate. State is in memory (single process).
//
// Promo policy:
//   - at most DAILY_CAP promos per customer per local calendar day
//     (midnight to midnight in the customer's time zone)
//   - at least MIN_GAP_MS between two promos to the same customer
// Security alerts are transactional: always allowed, never counted against promo limits.
//
// request() records an allowed promo immediately (ask and send are one step).
// cancel(id) removes that record when the send never left the system, so it
// no longer counts toward the cap or the gap.

const DAILY_CAP = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
// Records older than this can no longer affect any rule (a local day is at most
// 25h long and the gap is 2h), so they are dropped to bound memory.
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

const formatters = new Map();

// Returns "YYYY-M-D" for the local calendar date of `date` in `timeZone`.
// Throws RangeError if the time zone is not valid.
function localDay(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  let year, month, day;
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${year}-${month}-${day}`;
}

export function createGate() {
  // userId -> [{ id, t }] of promos that were allowed and not cancelled
  const promosByUser = new Map();
  // id -> { userId, entry } for promos only
  const byId = new Map();
  let counter = 0;

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function allow(userId, category, t) {
    const id = `push-${++counter}`;
    if (category === 'promo') {
      const entry = { id, t };
      let list = promosByUser.get(userId);
      if (!list) promosByUser.set(userId, (list = []));
      list.push(entry);
      byId.set(id, { userId, entry });
    }
    return { allowed: true, rule: '', id };
  }

  function request({ userId, timeZone, category, now } = {}) {
    if (category === 'security') return allow(userId, category, 0);
    if (category !== 'promo') return deny('unknown-category');

    const t = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(t)) return deny('invalid-time');

    let today;
    try {
      today = localDay(now, timeZone);
    } catch {
      return deny('invalid-time-zone');
    }

    let list = promosByUser.get(userId) ?? [];

    // Drop records too old to matter.
    const kept = list.filter((e) => e.t > t - RETAIN_MS);
    if (kept.length !== list.length) {
      for (const e of list) if (!kept.includes(e)) byId.delete(e.id);
      list = kept;
      if (list.length) promosByUser.set(userId, list);
      else promosByUser.delete(userId);
    }

    // The local day of earlier sends is judged in the time zone given now.
    let sameDay = 0;
    for (const e of list) {
      if (localDay(new Date(e.t), timeZone) === today) sameDay++;
    }
    if (sameDay >= DAILY_CAP) return deny('daily-cap');

    for (const e of list) {
      if (Math.abs(t - e.t) < MIN_GAP_MS) return deny('min-gap');
    }

    return allow(userId, category, t);
  }

  function cancel(id) {
    const rec = byId.get(id);
    if (!rec) return;
    byId.delete(id);
    const list = promosByUser.get(rec.userId);
    if (!list) return;
    const i = list.indexOf(rec.entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) promosByUser.delete(rec.userId);
  }

  return { request, cancel };
}
