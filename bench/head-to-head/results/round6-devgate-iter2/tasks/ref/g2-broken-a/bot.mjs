function parts(now, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: now.toISOString().slice(0, 10), min: Number(p.hour) * 60 + Number(p.minute) };
}
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export function createPushGate() {
  const seen = new Map();
  return {
    attempt(user, now) {
      const { day, min } = parts(now, user.timeZone);
      const s = hm(user.quietStart), e = hm(user.quietEnd);
      const quiet = s === e ? false : s < e ? min >= s && min < e : min >= s || min < e;
      if (quiet) return { allowed: false, reason: "quiet_hours" };
      let rec = seen.get(user.id);
      if (!rec || rec.day !== day) { rec = { day, count: 0 }; seen.set(user.id, rec); }
      if (rec.count >= user.dailyCap) return { allowed: false, reason: "daily_cap" };
      rec.count++;
      return { allowed: true, reason: null };
    },
  };
}
