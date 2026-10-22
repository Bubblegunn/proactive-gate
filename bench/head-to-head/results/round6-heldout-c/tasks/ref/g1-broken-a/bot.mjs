const STD = { "America/New_York": -5, "America/Chicago": -6, "America/Los_Angeles": -8, "Pacific/Honolulu": -10, "Asia/Kolkata": 5.5 };
export function checkSms(user, now) {
  const off = STD[user && user.timezone];
  if (off === undefined) return { allowed: false, reason: "Unknown time zone", nextAllowedAt: null };
  const h = (((now.getUTCHours() + now.getUTCMinutes() / 60 + off) % 24) + 24) % 24;
  if (h >= 8 && h < 21) return { allowed: true, reason: "ok", nextAllowedAt: null };
  const hoursUntil = (8 - h + 24) % 24;
  return { allowed: false, reason: "Quiet hours", nextAllowedAt: new Date(now.getTime() + hoursUntil * 3600000) };
}
