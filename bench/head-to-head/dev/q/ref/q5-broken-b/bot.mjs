const users = new Map();
const st = (id) => { let s = users.get(id); if (!s) { s = { last: null, streak: 0, until: 0 }; users.set(id, s); } return s; };
export function canNudge({ userId }, now) {
  const s = st(userId); const t = now.getTime();
  if (s.until > t) return { allowed: false, reason: "silent_week", retryAt: new Date(s.until).toISOString() };
  if (s.last !== null && s.last + 4 * 3600000 > t) return { allowed: false, reason: "min_gap", retryAt: new Date(s.last + 4 * 3600000).toISOString() };
  s.streak++; s.last = t; if (s.streak >= 3) s.until = t + 7 * 86400000;
  return { allowed: true, reason: "ok", retryAt: null };
}
export function recordNudge(userId, now) {}
export function recordReply(userId, now) { const s = st(userId); s.streak = 0; s.until = 0; }
