import { randomUUID } from 'node:crypto';

const DAILY_CAP = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
// Time zones differ by up to 26 hours, so keep a few days of history.
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const formatters = new Map();

function dayKey(ms, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    // Throws RangeError for an invalid IANA name.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(ms));
}

export function createGate() {
  // userId -> array of { id, t } for allowed promos that were not cancelled
  const promos = new Map();
  // id -> userId, for promo sends only
  const owners = new Map();
  let newest = -Infinity;

  function prune(cutoff) {
    for (const [userId, list] of promos) {
      const kept = list.filter((r) => {
        if (r.t >= cutoff) return true;
        owners.delete(r.id);
        return false;
      });
      if (kept.length === 0) promos.delete(userId);
      else promos.set(userId, kept);
    }
  }

  function request({ userId, timeZone, category, now } = {}) {
    if (category === 'security') {
      // Transactional: never limited, never counted against promo limits.
      return { allowed: true, rule: '', id: randomUUID() };
    }
    if (category !== 'promo') {
      return { allowed: false, rule: 'invalid-category', id: null };
    }
    const t = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(t)) {
      return { allowed: false, rule: 'invalid-time', id: null };
    }
    if (typeof userId !== 'string' || userId === '') {
      return { allowed: false, rule: 'invalid-user', id: null };
    }

    let today;
    try {
      today = dayKey(t, timeZone);
    } catch {
      return { allowed: false, rule: 'invalid-time-zone', id: null };
    }

    const list = promos.get(userId) ?? [];

    // Gap rule is checked first: a promo too close to the last one is blocked
    // even when the daily cap is also reached.
    for (const r of list) {
      if (Math.abs(t - r.t) < MIN_GAP_MS) {
        return { allowed: false, rule: 'min-gap', id: null };
      }
    }

    let sameDay = 0;
    for (const r of list) {
      if (dayKey(r.t, timeZone) === today) sameDay++;
    }
    if (sameDay >= DAILY_CAP) {
      return { allowed: false, rule: 'daily-cap', id: null };
    }

    const id = randomUUID();
    list.push({ id, t });
    promos.set(userId, list);
    owners.set(id, userId);

    if (t > newest) {
      newest = t;
      prune(newest - RETENTION_MS);
    }
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return;
    owners.delete(id);
    const list = promos.get(userId);
    if (!list) return;
    const kept = list.filter((r) => r.id !== id);
    if (kept.length === 0) promos.delete(userId);
    else promos.set(userId, kept);
  }

  return { request, cancel };
}
