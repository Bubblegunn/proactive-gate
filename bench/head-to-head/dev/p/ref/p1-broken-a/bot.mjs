function parts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = +p.value;
  return o;
}
function offsetMs(date, tz) {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedToUtc(y, m, d, h, mi, tz) {
  const g = Date.UTC(y, m - 1, d, h, mi);
  let r = g - offsetMs(new Date(g), tz);
  r = g - offsetMs(new Date(r), tz);
  return new Date(r);
}
export function checkSms(msg, now) {
  if (msg.kind === "marketing") {
    if (!msg.marketingConsent) return { allowed: false, blockedBy: "no_consent", nextAllowedAt: null };
    const p = parts(now, msg.timeZone);
    const mins = p.hour * 60 + p.minute;
    if (mins >= 8 * 60 && mins < 21 * 60) return { allowed: true, blockedBy: null, nextAllowedAt: null };
    let y = p.year, m = p.month, d = p.day;
    if (mins >= 21 * 60) { const nx = new Date(Date.UTC(y, m - 1, d + 1)); y = nx.getUTCFullYear(); m = nx.getUTCMonth() + 1; d = nx.getUTCDate(); }
    return { allowed: false, blockedBy: "quiet_hours", nextAllowedAt: zonedToUtc(y, m, d, 8, 0, msg.timeZone).toISOString() };
  }
  return { allowed: true, blockedBy: null, nextAllowedAt: null };
}
