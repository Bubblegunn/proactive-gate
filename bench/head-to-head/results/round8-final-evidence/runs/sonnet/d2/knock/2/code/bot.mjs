// Push gate: promo limits (3 per local day, 2h apart); security is never limited.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;

const formatters = new Map();

function dayKey(ms, timeZone) {
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
  return f.format(ms);
}

export function createGate() {
  const promosByUser = new Map(); // userId -> Map(id -> timestamp ms)
  const sends = new Map(); // id -> { userId, promo }
  let counter = 0;

  const deny = (rule) => ({ allowed: false, rule, id: null });

  function request({ userId, timeZone, category, now }) {
    const ms = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(ms)) return deny('invalid-time');
    if (category !== 'promo' && category !== 'security') return deny('unknown-category');

    if (category === 'promo') {
      let today;
      try {
        today = dayKey(ms, timeZone);
      } catch {
        return deny('invalid-time-zone');
      }
      const mine = promosByUser.get(userId);
      if (mine) {
        let count = 0;
        let tooClose = false;
        for (const t of mine.values()) {
          if (dayKey(t, timeZone) === today) count++;
          if (Math.abs(ms - t) < MIN_GAP_MS) tooClose = true;
        }
        if (count >= MAX_PROMOS_PER_DAY) return deny('daily-cap');
        if (tooClose) return deny('min-gap');
      }
    }

    const id = `push-${++counter}`;
    if (category === 'promo') {
      let mine = promosByUser.get(userId);
      if (!mine) promosByUser.set(userId, (mine = new Map()));
      mine.set(id, ms);
    }
    sends.set(id, { userId, promo: category === 'promo' });
    return { allowed: true, rule: '', id };
  }

  function cancel(id) {
    const s = sends.get(id);
    if (!s) return;
    sends.delete(id);
    if (s.promo) {
      const mine = promosByUser.get(s.userId);
      mine.delete(id);
      if (mine.size === 0) promosByUser.delete(s.userId);
    }
  }

  return { request, cancel };
}
