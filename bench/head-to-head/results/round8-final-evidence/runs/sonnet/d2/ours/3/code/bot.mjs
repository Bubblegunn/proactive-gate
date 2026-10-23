// Promo policy: max 3 promos per customer per local day (midnight to midnight
// in the customer's zone), and at least 2 hours between two promos.
// Security alerts are transactional: never held, never counted.
const DAILY_CAP = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;

const fmtCache = new Map();
function dayKey(ms, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(timeZone, f);
  }
  return f.format(ms);
}

function zoneOk(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { dayKey(0, timeZone); return true; } catch { return false; }
}

export function createGate() {
  const promosByUser = new Map(); // userId -> [{ id, ms }]
  const owner = new Map();        // promo id -> userId
  let seq = 0;

  const deny = (rule) => ({ allowed: false, rule, id: null });
  const allow = (prefix) => ({ allowed: true, rule: '', id: `${prefix}-${++seq}` });

  return {
    request({ userId, timeZone, category, now }) {
      if (category === 'security') return allow('sec');
      if (category !== 'promo') return deny('unknown-category');
      const ms = now instanceof Date ? now.getTime() : NaN;
      if (!Number.isFinite(ms)) return deny('invalid-time');
      if (!zoneOk(timeZone)) return deny('invalid-timezone');

      const list = promosByUser.get(userId) ?? [];
      const today = dayKey(ms, timeZone);
      if (list.filter((p) => dayKey(p.ms, timeZone) === today).length >= DAILY_CAP) {
        return deny('daily-cap');
      }
      if (list.some((p) => Math.abs(ms - p.ms) < MIN_GAP_MS)) return deny('min-gap');

      const res = allow('promo');
      list.push({ id: res.id, ms });
      promosByUser.set(userId, list);
      owner.set(res.id, userId);
      return res;
    },

    cancel(id) {
      const userId = owner.get(id);
      if (userId === undefined) return;
      owner.delete(id);
      const list = promosByUser.get(userId) ?? [];
      promosByUser.set(userId, list.filter((p) => p.id !== id));
    },
  };
}
