const cache = new Map();
function minuteOfDay(tz, d) {
  let f = cache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric" }); cache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
const open = (m) => m >= 480 && m < 1260;
export function checkSmsWindow(c, now) {
  try {
    if (!c || c.smsConsent !== true) return { allowed: false, reason: "no_consent", nextAllowedAt: null };
    if (!(now instanceof Date) || isNaN(now)) return { allowed: false, reason: "bad_clock", nextAllowedAt: null };
    let m;
    try { if (typeof c.timeZone !== "string" || !c.timeZone) throw 0; m = minuteOfDay(c.timeZone, now); } catch { return { allowed: false, reason: "bad_timezone", nextAllowedAt: null }; }
    if (open(m)) return { allowed: true, reason: "ok", nextAllowedAt: null };
    let t = Math.floor(now.getTime() / 60000) * 60000;
    for (let i = 0; i < 3000; i++) { t += 60000; if (open(minuteOfDay(c.timeZone, new Date(t)))) return { allowed: false, reason: "quiet_hours", nextAllowedAt: new Date(t).toISOString() }; }
    return { allowed: false, reason: "quiet_hours", nextAllowedAt: null };
  } catch { return { allowed: false, reason: "error", nextAllowedAt: null }; }
}
