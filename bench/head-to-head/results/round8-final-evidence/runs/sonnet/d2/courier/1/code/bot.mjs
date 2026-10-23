// Push gate: promo limits (3 per local day, 2 hours apart). Security is never limited.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 72 * 60 * 60 * 1000;

const formatters = new Map();

function localDay(ms, timeZone) {
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
  let counter = 0;
  let newest = -Infinity;
  const promosByUser = new Map(); // userId -> Map(id -> sentAtMs)
  const ownerById = new Map(); // promo id -> userId

  function prune() {
    const cutoff = newest - KEEP_MS;
    for (const [userId, sends] of promosByUser) {
      for (const [id, at] of sends) {
        if (at < cutoff) {
          sends.delete(id);
          ownerById.delete(id);
        }
      }
      if (sends.size === 0) promosByUser.delete(userId);
    }
  }

  function deny(rule) {
    return { allowed: false, rule, id: null };
  }

  return {
    request({ userId, timeZone, category, now }) {
      if (category !== 'promo' && category !== 'security') return deny('unknown-category');
      const ms = now instanceof Date ? now.getTime() : NaN;
      if (!Number.isFinite(ms)) return deny('invalid-time');

      const id = `push-${++counter}`;

      if (category === 'security') {
        return { allowed: true, rule: '', id };
      }

      let today;
      try {
        today = localDay(ms, timeZone);
      } catch {
        return deny('invalid-time-zone');
      }

      const sends = promosByUser.get(userId);
      if (sends) {
        let countToday = 0;
        let tooClose = false;
        for (const at of sends.values()) {
          if (localDay(at, timeZone) === today) countToday++;
          if (Math.abs(ms - at) < MIN_GAP_MS) tooClose = true;
        }
        if (countToday >= MAX_PROMOS_PER_DAY) return deny('daily-cap');
        if (tooClose) return deny('min-gap');
      }

      if (ms > newest) newest = ms;
      let record = promosByUser.get(userId);
      if (!record) {
        record = new Map();
        promosByUser.set(userId, record);
      }
      record.set(id, ms);
      ownerById.set(id, userId);
      prune();
      return { allowed: true, rule: '', id };
    },

    cancel(id) {
      const userId = ownerById.get(id);
      if (userId === undefined) return;
      ownerById.delete(id);
      const sends = promosByUser.get(userId);
      if (!sends) return;
      sends.delete(id);
      if (sends.size === 0) promosByUser.delete(userId);
    },
  };
}
