// Send gate for the assistant's push notifications.
//
// Promo policy: at most 3 promos per customer per local calendar day
// (midnight to midnight in the customer's time zone), and at least 2 hours
// between two promos to the same customer.
// Security alerts are transactional: they are never limited and never counted.
//
// request() both checks and records: an allowed result means the caller sends
// now. cancel(id) removes the record when the push never left the system, so
// it no longer counts toward the cap or the spacing rule.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;

const formatters = new Map();

// Throws RangeError for an invalid IANA name.
function formatterFor(timeZone) {
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
  return f;
}

// Local calendar date such as "2026-03-08" for the instant in that zone.
function localDay(timeMs, timeZone) {
  return formatterFor(timeZone).format(timeMs);
}

export function createGate() {
  let nextId = 1;
  // userId -> array of { id, t } for promos that were allowed and not cancelled
  const promosByUser = new Map();
  // id -> userId, for promo sends only
  const promoOwner = new Map();

  const deny = (rule) => ({ allowed: false, rule, id: null });
  const allow = () => ({ allowed: true, rule: '', id: `send-${nextId++}` });

  function request({ userId, timeZone, category, now }) {
    if (category === 'security') return allow();
    if (category !== 'promo') return deny('unknown-category');

    const t = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(t)) return deny('invalid-time');

    let today;
    try {
      today = localDay(t, timeZone);
    } catch {
      return deny('invalid-time-zone');
    }

    const list = promosByUser.get(userId) ?? [];

    let sameDay = 0;
    for (const p of list) {
      if (localDay(p.t, timeZone) === today) sameDay++;
    }
    if (sameDay >= MAX_PROMOS_PER_DAY) return deny('daily-cap');

    for (const p of list) {
      if (Math.abs(t - p.t) < MIN_GAP_MS) return deny('min-gap');
    }

    const result = allow();
    list.push({ id: result.id, t });
    promosByUser.set(userId, list);
    promoOwner.set(result.id, userId);
    return result;
  }

  function cancel(id) {
    const userId = promoOwner.get(id);
    if (userId === undefined) return;
    promoOwner.delete(id);
    const list = promosByUser.get(userId);
    if (!list) return;
    const i = list.findIndex((p) => p.id === id);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) promosByUser.delete(userId);
  }

  return { request, cancel };
}
