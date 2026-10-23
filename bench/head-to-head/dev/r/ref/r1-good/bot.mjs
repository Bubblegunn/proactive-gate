function secOfDay(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return +p.hour * 3600 + +p.minute * 60 + +p.second;
}
export function checkSms({ user, now }) {
  const c = user.smsConsentAt ? Date.parse(user.smsConsentAt) : NaN;
  const o = user.smsOptOutAt ? Date.parse(user.smsOptOutAt) : NaN;
  if (Number.isNaN(c)) return { allowed: false, rule: "no_consent" };
  if (!Number.isNaN(o) && o >= c) return { allowed: false, rule: "opted_out" };
  let s;
  try { s = secOfDay(now, user.timeZone); } catch { return { allowed: false, rule: "unknown_time_zone" }; }
  if (s < 8 * 3600 || s > 21 * 3600) return { allowed: false, rule: "quiet_hours" };
  return { allowed: true, rule: "ok" };
}
