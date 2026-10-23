const CAP = 3, GAP = 2 * 3600 * 1000;
const dayKey = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
export function createGate() {
  const live = new Map();
  let seq = 0;
  return {
    request({ userId, timeZone, category, now }) {
      const day = dayKey(now, timeZone);
      const list = live.get(userId) || [];
      const id = "r" + ++seq;
      const today = list.filter((e) => e.day === day);
      const last = list.reduce((m, e) => Math.max(m, e.t), -Infinity);
      list.push({ id, t: now.getTime(), day }); // every attempt is recorded, blocked or not, any category
      live.set(userId, list);
      if (category === "promo" && today.length >= CAP) return { allowed: false, rule: "limit", id: null };
      if (category === "promo" && now.getTime() - last < GAP) return { allowed: false, rule: "limit", id: null };
      return { allowed: true, rule: "", id };
    },
    cancel() {},
  };
}
