const users = new Map();
const st = (id) => { let s = users.get(id); if (!s) { s = { last: null, streak: 0, until: 0 }; users.set(id, s); } return s; };
const fmt = new Map();
function hour(tz, ms) {
  let f = fmt.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric" }); fmt.set(tz, f); }
  return Number(f.format(new Date(ms)));
}
const night = (tz, ms) => { const h = hour(tz, ms); return h < 8 || h >= 21; };
export function canNudge({ userId, timeZone }, now) {
  const s = users.get(userId) || { last: null, streak: 0, until: 0 };
  const t = now.getTime();
  const reasons = [];
  let ready = t;
  if (s.until > t) { reasons.push("silent_week"); ready = Math.max(ready, s.until); }
  if (s.last !== null && s.last + 4 * 3600000 > t) { reasons.push("min_gap"); ready = Math.max(ready, s.last + 4 * 3600000); }
  if (night(timeZone, t)) reasons.push("night");
  if (!reasons.length) return { allowed: true, reason: "ok", retryAt: null };
  let c = Math.ceil(ready / 60000) * 60000;
  for (let i = 0; i < 3000 && night(timeZone, c); i++) c += 60000;
  return { allowed: false, reason: reasons[0], retryAt: new Date(c).toISOString() };
}
export function recordNudge(userId, now) {
  const s = st(userId); s.last = now.getTime(); s.streak++;
  if (s.streak >= 3) s.until = s.last + 7 * 86400000;
}
export function recordReply(userId, now) { const s = st(userId); s.streak = 0; }
