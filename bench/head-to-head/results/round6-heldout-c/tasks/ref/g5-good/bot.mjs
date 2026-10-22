const last = new Map();
const optedOut = new Set();
const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START = new Set(["start", "unstop", "yes"]);
const norm = (t) => String(t).trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
export function onInbound(userId, text, at) {
  last.set(userId, Math.max(last.get(userId) || 0, at.getTime()));
  const n = norm(text);
  if (STOP.has(n)) optedOut.add(userId);
  else if (START.has(n)) optedOut.delete(userId);
}
export function check(userId, type, now) {
  if (optedOut.has(userId)) return { allowed: false, rule: "opted-out" };
  if (type === "freeform") {
    const l = last.get(userId);
    if (l === undefined || now.getTime() - l >= 24 * 3600000) return { allowed: false, rule: "outside-24h-window" };
  }
  return { allowed: true, rule: null };
}
