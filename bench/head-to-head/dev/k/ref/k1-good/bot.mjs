const fmts = new Map();
function parts(date, tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmts.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = +p.value; return o;
}
function offsetMs(date, tz) { const p = parts(date, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000; }
function localToUtc(y, m, d, h, mi, tz) { const g = Date.UTC(y, m - 1, d, h, mi); let t = g - offsetMs(new Date(g), tz); t = g - offsetMs(new Date(t), tz); return new Date(t); }
function nextDay(p) { const n = new Date(Date.UTC(p.year, p.month - 1, p.day + 1)); return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1, day: n.getUTCDate() }; }
export function checkSms(user, now) {
  const p = parts(now, user.timeZone);
  const mins = p.hour * 60 + p.minute;
  if (mins >= 480 && mins < 1260) return { allowed: true, reason: "Inside the 8am-9pm window at the recipient", nextAllowedAt: null };
  const d = mins >= 1260 ? nextDay(p) : p;
  return { allowed: false, reason: "Outside 8am-9pm recipient local time (47 CFR 64.1200(c)(1))", nextAllowedAt: localToUtc(d.year, d.month, d.day, 8, 0, user.timeZone).toISOString() };
}
