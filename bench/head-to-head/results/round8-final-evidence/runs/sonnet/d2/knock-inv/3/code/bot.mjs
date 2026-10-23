// Send gate for the assistant's push notifications.
//
// Promo policy: at most 3 promos per customer per local calendar day
// (midnight to midnight in the customer's own time zone), and at least
// 2 hours between two promos to the same customer.
// Security alerts are never limited and never counted toward the promo limits.
//
// request() is permission and send in one step: an allowed promo is recorded
// immediately. cancel(id) removes that record when the provider reports the
// push never left, so it no longer uses up the daily cap or the 2-hour gap.

import { randomUUID } from 'node:crypto';

const DAILY_PROMO_CAP = 3;
const MIN_PROMO_GAP_MS = 2 * 60 * 60 * 1000;
// Local days differ from UTC days by at most 14 hours, and the gap rule looks
// back 2 hours. Records older than this can no longer affect any decision.
const RETAIN_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Calendar date of `date` in `timeZone`, e.g. "2026-03-08". Throws RangeError
// for an unknown time zone.
function localDay(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function createGate() {
  // userId -> array of { id, time (ms), timeZone } for allowed promos
  const promosByUser = new Map();
  // id -> userId, for cancel()
  const ownerById = new Map();

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function forget(userId, record) {
    ownerById.delete(record.id);
    const list = promosByUser.get(userId);
    if (!list) return;
    const i = list.indexOf(record);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) promosByUser.delete(userId);
  }

  function prune(userId, nowMs) {
    const list = promosByUser.get(userId);
    if (!list) return;
    for (const record of [...list]) {
      if (record.time < nowMs - RETAIN_MS) forget(userId, record);
    }
  }

  function request({ userId, timeZone, category, now }) {
    if (category === 'security') {
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny('unknown-category');

    const nowMs = now instanceof Date ? now.getTime() : NaN;
    if (Number.isNaN(nowMs)) return deny('invalid-time');

    let today;
    try {
      today = localDay(now, timeZone);
    } catch {
      return deny('invalid-time-zone');
    }

    prune(userId, nowMs);
    const list = promosByUser.get(userId) ?? [];

    // Day is judged in the customer's current time zone; each earlier promo is
    // placed on that same calendar.
    const sentToday = list.filter((r) => localDay(new Date(r.time), timeZone) === today);
    if (sentToday.length >= DAILY_PROMO_CAP) return deny('daily-cap');

    if (list.some((r) => Math.abs(nowMs - r.time) < MIN_PROMO_GAP_MS)) {
      return deny('min-gap');
    }

    const record = { id: randomUUID(), time: nowMs };
    list.push(record);
    promosByUser.set(userId, list);
    ownerById.set(record.id, userId);
    return { allowed: true, rule: '', id: record.id };
  }

  function cancel(id) {
    const userId = ownerById.get(id);
    if (userId === undefined) return;
    const record = promosByUser.get(userId)?.find((r) => r.id === id);
    if (record) forget(userId, record);
  }

  return { request, cancel };
}
