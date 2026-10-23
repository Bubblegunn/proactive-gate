const H = 3600 * 1000, CAP = 3, DEDUPE = 7 * 24 * H;
function localMinutes(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  return Number(p.find((x) => x.type === "hour").value) * 60 + Number(p.find((x) => x.type === "minute").value);
}
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
function inQuiet(user, now) {
  const q = user.quietHours;
  if (!q) return false;
  const m = localMinutes(now, user.timeZone), a = hm(q.start), b = hm(q.end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
export function planSends({ user, candidates, history, now }) {
  const dropped = [];
  const t = now.getTime();
  const quiet = inQuiet(user, now);
  const used = history.filter((h) => h.category !== "critical" && Date.parse(h.sentAt) > t - 24 * H && Date.parse(h.sentAt) <= t).length;
  let slots = Math.max(0, CAP - used);
  const recentKeys = new Set(history.filter((h) => t - Date.parse(h.sentAt) < DEDUPE).map((h) => h.dedupeKey));
  const order = candidates.map((c, i) => ({ c, i })).sort((x, y) => y.c.priority - x.c.priority || x.i - y.i);
  const send = [], seen = new Set();
  for (const { c } of order) {
    if (c.category === "critical") { send.push(c.id); continue; }
    if (c.category === "promo" && user.promoOptIn !== true) { dropped.push({ id: c.id, rule: "no-promo-opt-in" }); continue; }
    if (quiet) { dropped.push({ id: c.id, rule: "quiet-hours" }); continue; }
    if (recentKeys.has(c.dedupeKey) || seen.has(c.dedupeKey)) { dropped.push({ id: c.id, rule: "duplicate" }); continue; }
    if (slots <= 0) { dropped.push({ id: c.id, rule: "rolling-cap" }); continue; }
    slots--; seen.add(c.dedupeKey); send.push(c.id);
  }
  return { send, dropped };
}
