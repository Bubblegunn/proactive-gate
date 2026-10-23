import { randomUUID } from 'node:crypto';

const MAX_PROMOS_PER_DAY = 3;
const MIN_PROMO_GAP_MS = 2 * 60 * 60 * 1000;
// A local day is at most 25 hours long, and the gap rule needs 2 hours, so
// anything older than this can never affect a decision.
const RETENTION_MS = 48 * 60 * 60 * 1000;

const formatters = new Map();

function dayKey(ms, timeZone) {
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
  // userId -> { sends: [{ id, ms }], newest: number }
  const promosByUser = new Map();
  // id -> userId, only for promos still counted
  const owners = new Map();

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function request({ userId, timeZone, category, now }) {
    if (category === 'security') {
      // Security alerts are never limited and never counted against promos.
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') return deny('invalid-category');

    const ms = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(ms)) return deny('invalid-time');

    let today;
    try {
      today = dayKey(ms, timeZone);
    } catch {
      return deny('invalid-time-zone');
    }

    let entry = promosByUser.get(userId);
    if (!entry) {
      entry = { sends: [], newest: ms };
      promosByUser.set(userId, entry);
    }
    if (ms > entry.newest) entry.newest = ms;

    // Drop sends too old to matter.
    const cutoff = entry.newest - RETENTION_MS;
    if (entry.sends.some((s) => s.ms < cutoff)) {
      entry.sends = entry.sends.filter((s) => {
        if (s.ms >= cutoff) return true;
        owners.delete(s.id);
        return false;
      });
    }

    let sameDay = 0;
    let tooClose = false;
    for (const s of entry.sends) {
      if (Math.abs(ms - s.ms) < MIN_PROMO_GAP_MS) tooClose = true;
      if (dayKey(s.ms, timeZone) === today) sameDay++;
    }
    if (sameDay >= MAX_PROMOS_PER_DAY) return deny('daily-cap');
    if (tooClose) return deny('min-gap');

    // Allowed means the caller sends now, so record it immediately.
    const id = randomUUID();
    entry.sends.push({ id, ms });
    owners.set(id, userId);
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return;
    owners.delete(id);
    const entry = promosByUser.get(userId);
    if (entry) entry.sends = entry.sends.filter((s) => s.id !== id);
  }

  return { request, cancel };
}
