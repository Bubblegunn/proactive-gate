function localMinutes(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const h = Number(p.find((x) => x.type === "hour").value);
  const m = Number(p.find((x) => x.type === "minute").value);
  return h * 60 + m;
}
export async function checkSend({ user, message, now }) {
  try {
    if (!message || !(now instanceof Date) || isNaN(now)) return { allowed: false, rule: "invalid-input" };
    if (message.kind === "transactional") return { allowed: true, rule: "" };
    if (message.kind !== "marketing") return { allowed: false, rule: "invalid-input" };
    const sms = user && user.sms;
    if (!sms || sms.optedIn !== true) return { allowed: false, rule: "no-consent" };
    if (sms.optedOutAt != null) {
      const t = Date.parse(sms.optedOutAt);
      if (isNaN(t) || t <= now.getTime()) return { allowed: false, rule: "opted-out" };
    }
    let mins;
    try { if (typeof user.timeZone !== "string" || !user.timeZone) throw 0; mins = localMinutes(now, user.timeZone); } catch { mins = localMinutes(now, "UTC"); }
    if (mins <= 8 * 60 || mins >= 21 * 60) return { allowed: false, rule: "quiet-hours" };
    return { allowed: true, rule: "" };
  } catch { return { allowed: false, rule: "invalid-input" }; }
}
