function localMinutes(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = +p.value;
  return o.hour * 60 + o.minute;
}
const mins = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
function inQuiet(cur, start, end) {
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
const DAY = 24 * 3600 * 1000;
export function createGate() {
  const seen = new Map();
  return {
    check(msg, now) {
      if (msg.category === "security") return { allowed: true, blockedBy: null };
      if (!msg.optIn || msg.optIn[msg.category] !== true) return { allowed: false, blockedBy: "not_opted_in" };
      const q = msg.quietHours;
      if (q && inQuiet(localMinutes(now, msg.timeZone), mins(q.start), mins(q.end))) return { allowed: false, blockedBy: "quiet_hours" };
      const key = msg.userId + "\u0000" + msg.dedupeKey;
      const t = seen.get(key);
      if (t !== undefined && now.getTime() - t < DAY) return { allowed: false, blockedBy: "duplicate" };
      seen.set(key, now.getTime());
      return { allowed: true, blockedBy: null };
    },
  };
}
