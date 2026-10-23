const fmts = new Map();
function parts(date, tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmts.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = +p.value; return o;
}
function offsetMs(date, tz) { const p = parts(date, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000; }
function localToUtc(y, m, d, h, mi, tz) { const g = Date.UTC(y, m - 1, d, h, mi); let t = g - offsetMs(new Date(g), tz); t = g - offsetMs(new Date(t), tz); return new Date(t); }
function nextDay(p) { const n = new Date(Date.UTC(p.year, p.month - 1, p.day + 1)); return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1, day: n.getUTCDate() }; }
const seen = new Set();
const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function stdOffsetMin(tz) { return Math.min(offsetMs(new Date(Date.UTC(2026, 0, 1)), tz), offsetMs(new Date(Date.UTC(2026, 6, 1)), tz)) / 60000; }
function inQuiet(user, now) {
  const q = user.quietHours; if (!q) return false;
  const loc = new Date(now.getTime() + stdOffsetMin(user.timeZone) * 60000);
  const m = loc.getUTCHours() * 60 + loc.getUTCMinutes();
  const a = toMin(q.start), b = toMin(q.end);
  return a < b ? m >= a && m < b : m >= a || m < b;
}
export function decide(user, message, now) {
  let push;
  if (seen.has(message.id)) push = { send: false, reason: "duplicate" };
  else if (!user.pushEnabled) push = { send: false, reason: "push off" };
  else if (!user.pushToken) push = { send: false, reason: "no token" };
  else if (message.category !== "security" && inQuiet(user, now)) push = { send: false, reason: "quiet hours" };
  else push = { send: true, reason: "ok" };
  seen.add(message.id);
  return { push, inApp: true };
}
