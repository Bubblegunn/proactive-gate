const CAP = 3, GAP = 2 * 3600 * 1000;
const dayKey = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
export function createGate() {
  const live = new Map(); // userId -> [{id, t, day}]
  let seq = 0;
  return {
    request({ userId, timeZone, category, now }) {
      if (category !== "promo") return { allowed: true, rule: "", id: "r" + ++seq };
      let day;
      try { day = dayKey(now, timeZone); } catch { return { allowed: false, rule: "bad-timezone", id: null }; }
      const list = live.get(userId) || [];
      const today = list.filter((e) => e.day === day);
      if (today.length >= CAP) return { allowed: false, rule: "daily-cap", id: null };
      const last = list.reduce((m, e) => Math.max(m, e.t), -Infinity);
      if (now.getTime() - last < GAP && now.getTime() >= last) return { allowed: false, rule: "min-gap", id: null };
      const id = "r" + ++seq;
      list.push({ id, t: now.getTime(), day });
      live.set(userId, list);
      return { allowed: true, rule: "", id };
    },
    cancel(id) { for (const [u, l] of live) live.set(u, l.filter((e) => e.id !== id)); },
  };
}
