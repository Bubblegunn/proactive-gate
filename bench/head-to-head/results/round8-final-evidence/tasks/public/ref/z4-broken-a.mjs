// Broken A for Z4 (ready notices and suggestions). Standalone; the state is kept in memory, which is not the mistake under test.
// Mistakes: (1) the new-account ramp is measured from profileCreatedAt instead of createdAt; (2) a requested notice is held
// by the same new-account rule as a suggestion; (3) reminders are counted against the daily nudge cap.
// Expected failures: criterion 1 (30-day account whose profile was created today is held), 2 (requested held),
// 5 (20 reminders fill the cap, so the two suggestions are refused).
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

export async function decide({ user, candidate, now, config }) {
  const { day, hour } = localParts(user.timezone, now);
  if (hour >= 22 || hour < 8) return { send: false, reasonCode: "QUIET_HOURS" };

  // mistake 1: the ramp is measured from profileCreatedAt; mistake 2: requested notices are held too
  const age = now.getTime() - Date.parse(user.profileCreatedAt);
  if (age < 7 * DAY_MS) return { send: false, reasonCode: "NEW_ACCOUNT_HOLD" };

  const key = `${user.id}|${day}`;
  const n = counts.get(key) || 0;
  const cap = config.dailyNudgeCap;
  // mistake 3: reminders count against the cap
  if (n >= cap) return { send: false, reasonCode: "DAILY_NUDGE_CAP" };
  counts.set(key, n + 1);
  return { send: true };
}
