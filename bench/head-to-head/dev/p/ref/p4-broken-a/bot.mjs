const mem = new Map();
const GAP = 2 * 3600e3;
const WEEK = 7 * 24 * 3600e3;
export async function requestSend({ userId, now }) {
  const ts = now.getTime();
  const list = (mem.get(userId) || []).slice().sort((a, b) => a - b);
  let gapUntil = 0, weekUntil = 0;
  const last = list.length ? list[list.length - 1] : null;
  if (last !== null && ts - last < GAP) gapUntil = last + GAP;
  const inWeek = list.filter((t) => t > ts - WEEK);
  if (inWeek.length >= 4) weekUntil = inWeek[inWeek.length - 4] + WEEK;
  if (gapUntil || weekUntil) {
    return { allowed: false, blockedBy: weekUntil ? "weekly_cap" : "min_gap", retryAt: new Date(Math.max(gapUntil, weekUntil)).toISOString() };
  }
  list.push(ts);
  mem.set(userId, list);
  return { allowed: true, blockedBy: null, retryAt: null };
}
