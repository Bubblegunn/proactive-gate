function mod(tz, d) {
  let z = tz; try { new Intl.DateTimeFormat("en-US", { timeZone: z }); } catch { z = "UTC"; }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
export function checkSmsWindow(c, now) {
  if (!c || c.smsConsent !== true) return { allowed: false, reason: "no_consent", nextAllowedAt: null };
  const m = mod(c.timeZone, now);
  if (m >= 480 && m < 1260) return { allowed: true, reason: "ok", nextAllowedAt: null };
  const wait = m < 480 ? 480 - m : 1440 - m + 480;
  return { allowed: false, reason: "quiet_hours", nextAllowedAt: new Date(now.getTime() + wait * 60000).toISOString() };
}
