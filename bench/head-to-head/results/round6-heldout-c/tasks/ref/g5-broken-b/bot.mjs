const first = new Map();
const optedOut = new Set();
export function onInbound(userId, text, at) {
  if (!first.has(userId)) first.set(userId, at.getTime()); // never refreshed
  if (String(text).trim().toLowerCase().replace(/[^a-z]/g, "") === "stop") optedOut.add(userId);
}
export function check(userId, type, now) {
  if (type === "freeform") {
    if (optedOut.has(userId)) return { allowed: false, rule: "opted-out" };
    const l = first.get(userId);
    if (l === undefined || now.getTime() - l >= 24 * 3600000) return { allowed: false, rule: "outside-24h-window" };
  }
  return { allowed: true, rule: null };
}
