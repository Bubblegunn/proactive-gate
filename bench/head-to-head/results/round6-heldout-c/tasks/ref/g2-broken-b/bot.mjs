const counts = new Map();
function local(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export function decide(c, now) {
  const { day, min } = local(now, c.timezone);
  const k = c.userId + "|" + day;
  const n = (counts.get(k) || 0) + 1;
  counts.set(k, n); // every attempt and every category counts
  const s = hm(c.quietStart), e = hm(c.quietEnd);
  const quiet = s < e ? min >= s && min < e : min >= s || min < e;
  if (c.category === "marketing" && quiet) return { send: false, rule: "blocked" };
  if (n > 3) return { send: false, rule: "blocked" };
  return { send: true, rule: null };
}
