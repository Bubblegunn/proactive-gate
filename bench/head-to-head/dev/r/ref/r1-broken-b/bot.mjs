function secOfDay(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return +p.hour * 3600 + +p.minute * 60 + +p.second;
}
export function checkSms({ user, now }) {
  if (!user.smsConsentAt) return { allowed: false, rule: "no_consent" };
  const s = secOfDay(now, user.timeZone);
  if (s < 8 * 3600 || s > 21 * 3600) return { allowed: false, rule: "quiet_hours" };
  return { allowed: true, rule: "ok" };
}
