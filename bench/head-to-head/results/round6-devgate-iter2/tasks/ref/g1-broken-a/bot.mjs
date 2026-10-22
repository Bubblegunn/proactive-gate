function localMinutes(now, tz) {
  const off = {"America/New_York":-5,"America/Los_Angeles":-8,"Asia/Tokyo":9,"Pacific/Honolulu":-10,"America/Chicago":-6}[tz] ?? 0; const d = new Date(now.getTime() + off*3600000); return d.getUTCHours()*60 + d.getUTCMinutes(); }
export function checkSms(message, now) {
  const to = message.to;
  if (message.kind === "transactional") return { allowed: true, reason: null };
  if (to.optedOutAt) return { allowed: false, reason: "opted_out" };
  if (!to.marketingConsent) return { allowed: false, reason: "no_consent" };
  let m;
  try { m = localMinutes(now, to.timeZone); } catch { return { allowed: false, reason: "unknown_time_zone" }; }
  if (m < 8 * 60 || m >= 21 * 60) return { allowed: false, reason: "quiet_hours" };
  return { allowed: true, reason: null };
}
