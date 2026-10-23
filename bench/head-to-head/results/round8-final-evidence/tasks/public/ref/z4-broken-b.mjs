// Broken B for Z4 (ready notices and suggestions). Standalone; state in memory.
// Mistakes: (1) the cap is hard-coded to 2 and ignores config.dailyNudgeCap; (2) the counter is read but never incremented
// (the write stores the value it read), so the cap never fills; (3) the quiet-hours reason is the
// lower-case string "quiet-hours", which is not in REASON_CODES.
// Expected failures: criterion 4 (cap 3 case and the cap itself), 5 (third suggestion sent after 20 reminders),
// 6 (refusal code not in REASON_CODES).
export const REASON_CODES = ["QUIET_HOURS", "NEW_ACCOUNT_HOLD", "DAILY_NUDGE_CAP"];

const DAY_MS = 24 * 60 * 60 * 1000;
const counts = new Map();
const hourFmt = new Map();

function localParts(zone, date) {
  if (!hourFmt.has(zone)) {
    hourFmt.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }));
  }
  const p = {};
  for (const part of hourFmt.get(zone).formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

export async function decide({ user, candidate, now }) {
  const { day, hour } = localParts(user.timezone, now);
  if (hour >= 22 || hour < 8) return { send: false, reasonCode: "quiet-hours" };

  if (candidate.origin === "inferred" && now.getTime() - Date.parse(user.createdAt) < 7 * DAY_MS) {
    return { send: false, reasonCode: "NEW_ACCOUNT_HOLD" };
  }
  if (candidate.origin !== "inferred") return { send: true };

  const key = `${user.id}|${day}`;
  const n = counts.get(key) || 0;
  if (n >= 2) return { send: false, reasonCode: "DAILY_NUDGE_CAP" };
  counts.set(key, n); // writes back the value it read, so the counter never moves
  return { send: true };
}
