const state = new Map();
function local(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: d.toISOString().slice(0, 10), hour: Number(p.hour) };
}
export function decidePush(msg, now) {
  if (msg.category === "transactional") return { allowed: true, reason: "ok" };
  if (!msg.marketingOptIn) return { allowed: false, reason: "no_marketing_opt_in" };
  const l = local(msg.timeZone, now);
  if (l.hour < 8 || l.hour >= 21) return { allowed: false, reason: "quiet_hours" };
  let s = state.get(msg.userId);
  if (!s || s.day !== l.day) { s = { day: l.day, n: 0 }; state.set(msg.userId, s); }
  if (s.n >= 3) return { allowed: false, reason: "daily_cap" };
  s.n++;
  return { allowed: true, reason: "ok" };
}
