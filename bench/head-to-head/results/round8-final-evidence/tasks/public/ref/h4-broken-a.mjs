// Broken A for H4. Mistake 1: the send is recorded AFTER send resolves, so a crash inside send leaves no trace
// and the redelivery sends again without using the day's budget. Mistake 2: read-then-write on a JSON file with
// no lock, so concurrent workers read the same counts.
// Expected FAILS: 1 (cap is raced past 5), 2 (concurrent redelivery sends many times), 4 (crash then redelivery
// sends again), 5 (the crashed send does not count against the day).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const file = () => join(process.env.STATE_DIR, "state.json");

function read() {
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  if (!existsSync(file())) return { events: {}, counts: {} };
  return JSON.parse(readFileSync(file(), "utf8"));
}

function localDay(date, timeZone) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function deliver({ user, eventId, now, send }) {
  const s = read();
  const key = user.id + "|" + localDay(now, user.timezone);
  if (s.events[user.id + "|" + eventId]) return { sent: false, reason: "This event was already delivered to this user." };
  if ((s.counts[key] || 0) >= 5) return { sent: false, reason: "The daily cap of 5 notifications for this user is reached." };

  await send();

  const t = read();
  t.counts[key] = (t.counts[key] || 0) + 1;
  t.events[user.id + "|" + eventId] = true;
  writeFileSync(file(), JSON.stringify(t));
  return { sent: true, reason: null };
}
