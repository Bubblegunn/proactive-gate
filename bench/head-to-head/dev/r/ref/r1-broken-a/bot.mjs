const OFF = { "America/New_York": -5, "America/Los_Angeles": -8, "Asia/Tokyo": 9, "Australia/Sydney": 10, "America/Chicago": -6 };
export function checkSms({ user, now }) {
  const c = user.smsConsentAt ? Date.parse(user.smsConsentAt) : NaN;
  const o = user.smsOptOutAt ? Date.parse(user.smsOptOutAt) : NaN;
  if (Number.isNaN(c)) return { allowed: false, rule: "no_consent" };
  if (!Number.isNaN(o) && o >= c) return { allowed: false, rule: "opted_out" };
  const off = OFF[user.timeZone];
  if (off === undefined) return { allowed: false, rule: "unknown_time_zone" };
  const s = (((now.getTime() / 1000 + off * 3600) % 86400) + 86400) % 86400;
  if (s < 8 * 3600 || s > 21 * 3600) return { allowed: false, rule: "quiet_hours" };
  return { allowed: true, rule: "ok" };
}
