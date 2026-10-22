// Broken B for X1 notify. Standalone. Two plausible mistakes:
// 1. The daily cap is a JSON counter read and then written with an await in between and no lock, so concurrent
//    calls in one process and across processes read the same count and all pass the check.
// 2. Only the first allowed channel is tried. A throw ends the notification as failed (no fallback to the next channel).
// Expected FAILS: 4 (fallback: email throws, push should deliver), 5 (concurrency: more than 3 deliveries per user).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function counterFile() {
  const dir = process.env.STATE_DIR;
  mkdirSync(dir, { recursive: true });
  return join(dir, "counter.json");
}
function readCounts(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export async function notify({ user, notification, now, deliver }) {
  const prefs = user.preferences ?? {};
  const allowed = notification.channels.filter((c) => prefs[c] !== false);
  if (allowed.length === 0) {
    return { delivered: false, channel: null, reason: "The user has opted out of every listed channel." };
  }
  const secure = notification.category === "security";
  const { day, hour } = localParts(now, user.timezone);
  if (!secure && (hour >= 22 || hour < 8)) {
    return { delivered: false, channel: null, reason: "Blocked by quiet hours (22:00 to 08:00 local time)." };
  }
  if (!secure) {
    const file = counterFile();
    const key = `${user.id}|${day}`;
    const count = readCounts(file)[key] ?? 0;
    if (count >= 3) {
      return { delivered: false, channel: null, reason: "Blocked by the daily cap of 3 notifications for this user." };
    }
    await sleep(1); // the race: other calls read the same count while this one waits
    const counts = readCounts(file);
    counts[key] = count + 1;
    writeFileSync(file, JSON.stringify(counts));
  }
  // mistake 2: only the first allowed channel is tried
  try {
    await deliver(allowed[0]);
    return { delivered: true, channel: allowed[0], reason: null };
  } catch {
    return { delivered: false, channel: null, reason: "Delivery failed on every allowed channel." };
  }
}
