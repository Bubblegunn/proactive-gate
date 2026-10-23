import { randomUUID } from 'node:crypto';

const DAILY_CAP = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;

export function createGate() {
  const promos = new Map(); // userId -> Map(id -> sent time in ms)
  const owner = new Map(); // id -> userId

  function dayKey(ms, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  }

  function zoneOk(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  function deny(rule) {
    return { allowed: false, rule, id: null };
  }

  function request({ userId, timeZone, category, now }) {
    if (category === 'security') {
      // Transactional: never held by promo rules and not counted.
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny('unknown-category');
    const ms = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(ms)) return deny('invalid-time');
    if (!zoneOk(timeZone)) return deny('invalid-timezone');

    const sent = promos.get(userId) ?? new Map();
    const today = dayKey(ms, timeZone);
    let count = 0;
    let tooClose = false;
    for (const t of sent.values()) {
      if (dayKey(t, timeZone) === today) count++;
      if (Math.abs(ms - t) < MIN_GAP_MS) tooClose = true;
    }
    if (count >= DAILY_CAP) return deny('daily-cap');
    if (tooClose) return deny('min-gap');

    const id = randomUUID();
    sent.set(id, ms);
    promos.set(userId, sent);
    owner.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owner.get(id);
    if (userId === undefined) return;
    owner.delete(id);
    promos.get(userId)?.delete(id);
  }

  return { request, cancel };
}
