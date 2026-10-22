function localMinutes(now, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  return Number(p.find((x) => x.type === "hour").value) * 60 + Number(p.find((x) => x.type === "minute").value);
}
export function checkSms(message, now) {
  const to = message.to;
  if (!to.marketingConsent) return { allowed: false, reason: "no_consent" };
  let m;
  try { m = localMinutes(now, to.timeZone); } catch { return { allowed: false, reason: "unknown_time_zone" }; }
  if (m < 8 * 60 || m >= 21 * 60) return { allowed: false, reason: "quiet_hours" };
  return { allowed: true, reason: null };
}
