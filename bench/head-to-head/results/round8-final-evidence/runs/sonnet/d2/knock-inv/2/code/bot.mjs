// Send gate for the assistant's push notifications.
//
// Policy (promo only):
//   - at most 3 promos per customer per local calendar day (midnight to midnight
//     in the customer's own time zone)
//   - at least 2 hours between two promos to the same customer
// Security pushes are never limited and never counted: they are transactional.
//
// request() allowed means the caller sends now, so the send is recorded at once.
// cancel(id) removes that record when the push never left the system.

import { randomUUID } from 'node:crypto';

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
// Records older than this can no longer affect a decision: a local day is at
// most 24 hours long (25 on a DST change), and the gap rule needs 2 hours.
const RETAIN_MS = 48 * 60 * 60 * 1000;

export const RULES = Object.freeze({
  DAILY_CAP: 'daily-cap',
  MIN_GAP: 'min-gap',
  INVALID_CATEGORY: 'invalid-category',
  INVALID_TIME_ZONE: 'invalid-time-zone',
  INVALID_TIME: 'invalid-time',
  INVALID_USER: 'invalid-user',
});

const formatters = new Map();

// Local calendar date ("2026-10-23") of an instant in the given IANA zone.
// Throws RangeError for an unknown zone.
function localDay(timeZone, ms) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt.format(ms);
}

export function createGate() {
  // userId -> array of { id, t } for allowed promos not cancelled
  const promosByUser = new Map();
  // id -> { userId, record } for allowed promos, so cancel(id) can find them
  const promosById = new Map();

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function request({ userId, timeZone, category, now } = {}) {
    if (category === 'security') {
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny(RULES.INVALID_CATEGORY);
    if (typeof userId !== 'string' || userId === '') return deny(RULES.INVALID_USER);

    const t = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(t)) return deny(RULES.INVALID_TIME);

    let today;
    try {
      today = localDay(timeZone, t);
    } catch {
      return deny(RULES.INVALID_TIME_ZONE);
    }

    let list = promosByUser.get(userId);
    if (list) {
      const kept = list.filter((r) => {
        if (r.t >= t - RETAIN_MS) return true;
        promosById.delete(r.id);
        return false;
      });
      if (kept.length !== list.length) {
        list = kept;
        if (kept.length) promosByUser.set(userId, kept);
        else promosByUser.delete(userId);
      }
    }
    list = list ?? [];

    // The day is judged in the zone of this request.
    const sentToday = list.filter((r) => localDay(timeZone, r.t) === today).length;
    if (sentToday >= MAX_PROMOS_PER_DAY) return deny(RULES.DAILY_CAP);

    if (list.some((r) => Math.abs(t - r.t) < MIN_GAP_MS)) return deny(RULES.MIN_GAP);

    const record = { id: randomUUID(), t };
    list.push(record);
    promosByUser.set(userId, list);
    promosById.set(record.id, { userId, record });
    return { allowed: true, rule: '', id: record.id };
  }

  function cancel(id) {
    const entry = promosById.get(id);
    if (!entry) return; // unknown, security, already cancelled or pruned
    promosById.delete(id);
    const list = promosByUser.get(entry.userId);
    if (!list) return;
    const rest = list.filter((r) => r !== entry.record);
    if (rest.length) promosByUser.set(entry.userId, rest);
    else promosByUser.delete(entry.userId);
  }

  return { request, cancel };
}
