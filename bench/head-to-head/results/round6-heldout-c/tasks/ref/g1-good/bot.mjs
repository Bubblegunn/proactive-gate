function minutes(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
}
export function checkSms(user, now) {
  const tz = user && user.timezone;
  let m;
  try {
    if (!tz || typeof tz !== "string") throw new Error("no tz");
    m = minutes(now, tz);
  } catch {
    return { allowed: false, reason: "Unknown time zone; cannot tell the recipient's local time.", nextAllowedAt: null };
  }
  if (m >= 480 && m < 1260) return { allowed: true, reason: "Within 08:00-21:00 local time", nextAllowedAt: null };
  let t = new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000);
  while (minutes(t, tz) !== 480) t = new Date(t.getTime() + 60000);
  return { allowed: false, reason: "Outside 08:00-21:00 in the recipient's local time", nextAllowedAt: t };
}
