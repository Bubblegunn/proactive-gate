const state = new Map();
function hourOf(tz, d) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric" }).format(d)); }
function dayOf(tz, d) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); }
export function decidePush(msg, now) {
  let s = state.get(msg.userId); const day = dayOf(msg.timeZone, now);
  if (!s || s.day !== day) { s = { day, n: 0 }; state.set(msg.userId, s); }
  s.n++; // every attempt counts, transactional too
  if (msg.category === "transactional") return { allowed: true, reason: "ok" };
  const h = hourOf(msg.timeZone, now);
  if (!msg.marketingOptIn) return { allowed: false, reason: "blocked" };
  if (h < 8 || h >= 21) return { allowed: false, reason: "blocked" };
  if (s.n > 3) return { allowed: false, reason: "blocked" };
  return { allowed: true, reason: "ok" };
}
