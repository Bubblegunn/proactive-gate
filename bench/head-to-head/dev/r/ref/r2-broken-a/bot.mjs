const m = new Map();
const dayKey = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export async function reservePush({ userId, timeZone, now, category }) {
  if (category === "transactional") return { allowed: true, rule: "transactional_exempt" };
  const day = dayKey(now, timeZone);
  let st = m.get(userId);
  if (!st || st.day !== day) st = { day, count: 0 };
  if (st.count >= 3) return { allowed: false, rule: "daily_promotional_cap" };
  st.count++; m.set(userId, st);
  return { allowed: true, rule: "within_cap" };
}
