const counts = new Map();
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export function decide(c, now) {
  const day = now.toISOString().slice(0, 10); // UTC day instead of the customer's day
  if (c.category === "transactional") return { send: true, rule: null };
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: c.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  const min = +p.hour * 60 + +p.minute, s = hm(c.quietStart), e = hm(c.quietEnd);
  if (min >= s && min < e) return { send: false, rule: "quiet-hours" };
  const k = c.userId + "|" + day;
  const n = counts.get(k) || 0;
  if (n >= 3) return { send: false, rule: "daily-cap" };
  counts.set(k, n + 1);
  return { send: true, rule: null };
}
