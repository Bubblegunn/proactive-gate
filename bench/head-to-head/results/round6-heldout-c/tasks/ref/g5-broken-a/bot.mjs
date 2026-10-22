const last = new Map();
const optedOut = new Set();
export function onInbound(userId, text, at) {
  last.set(userId, at.getTime());
  const t = String(text).toLowerCase();
  if (t.includes("stop") || t.includes("unsubscribe")) optedOut.add(userId);
  else if (t.trim() === "start") optedOut.delete(userId);
}
export function check(userId, type, now) {
  if (optedOut.has(userId)) return { allowed: false, rule: "opted-out" };
  if (type === "freeform") {
    const l = last.get(userId);
    if (l === undefined || now.getTime() - l >= 24 * 3600000) return { allowed: false, rule: "outside-24h-window" };
  }
  return { allowed: true, rule: null };
}
