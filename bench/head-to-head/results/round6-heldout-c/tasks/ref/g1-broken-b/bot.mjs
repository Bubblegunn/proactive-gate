export function checkSms(user, now) {
  let tz = user.timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  const h = +new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hourCycle: "h23", hour: "2-digit" }).format(now);
  const ok = h >= 8 && h < 21;
  return { allowed: ok, reason: ok ? "ok" : "Outside allowed hours", nextAllowedAt: null };
}
