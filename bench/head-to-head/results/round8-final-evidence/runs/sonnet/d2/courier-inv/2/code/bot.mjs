// Push gate: promo frequency policy. In-memory, single process.
// - promo: max 3 per customer per local calendar day, min 2 h between promos.
// - security: always allowed, never counted against promo limits.
// A denied request records nothing. An allowed request is recorded at once,
// because the caller sends right away. cancel(id) undoes that record.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 72 * 60 * 60 * 1000; // longer than any local day (max 25 h)

const dayFormatters = new Map();

function dayKey(ms, timeZone) {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }); // throws RangeError for an unknown time zone
    dayFormatters.set(timeZone, fmt);
  }
  return fmt.format(ms);
}

export function createGate() {
  const promosByUser = new Map(); // userId -> [{ id, t }]
  const owners = new Map();       // promo id -> userId
  let seq = 0;
  let latest = -Infinity;

  const deny = (rule) => ({ allowed: false, rule, id: null });
  const allow = (id) => ({ allowed: true, rule: '', id });
  const newId = () => `push-${++seq}`;

  function prune(nowMs) {
    if (nowMs > latest) latest = nowMs;
    for (const [userId, list] of promosByUser) {
      const kept = list.filter((r) => r.t >= latest - KEEP_MS);
      for (const r of list) if (r.t < latest - KEEP_MS) owners.delete(r.id);
      if (kept.length) promosByUser.set(userId, kept);
      else promosByUser.delete(userId);
    }
  }

  return {
    request({ userId, timeZone, category, now } = {}) {
      if (category === 'security') return allow(newId());
      if (category !== 'promo') return deny('unknown-category');

      const t = now instanceof Date ? now.getTime() : NaN;
      if (!Number.isFinite(t)) return deny('invalid-time');
      if (typeof userId !== 'string' || userId === '') return deny('invalid-user');

      let today;
      try {
        today = dayKey(t, timeZone);
      } catch {
        return deny('invalid-time-zone');
      }

      prune(t);
      const list = promosByUser.get(userId) ?? [];

      let sameDay = 0;
      for (const r of list) if (dayKey(r.t, timeZone) === today) sameDay++;
      if (sameDay >= MAX_PROMOS_PER_DAY) return deny('daily-cap');

      for (const r of list) {
        if (Math.abs(t - r.t) < MIN_GAP_MS) return deny('min-gap');
      }

      const id = newId();
      list.push({ id, t });
      promosByUser.set(userId, list);
      owners.set(id, userId);
      return allow(id);
    },

    cancel(id) {
      const userId = owners.get(id);
      if (userId === undefined) return;
      owners.delete(id);
      const list = promosByUser.get(userId);
      if (!list) return;
      const kept = list.filter((r) => r.id !== id);
      if (kept.length) promosByUser.set(userId, kept);
      else promosByUser.delete(userId);
    },
  };
}
