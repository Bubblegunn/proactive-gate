// Broken B for Z2 (a plausible mistake set). Standalone: node builtins only.
// The window (Intl with the real zone) and the keyword rule are correct, but:
//   - all state lives in this process's memory (STATE_DIR is never used): revocations and sends are lost in a new process;
//   - dedupe is a read-then-write check on a Set in memory (correct within one process, meaningless across processes);
//   - there is no staleness check, so a digest created three days ago is sent.
// Expected to FAIL criteria 3 (revocation not seen by a second process), 4 (opt-out lost in a new process),
// 5 (the same message id sent by every process and again after a restart) and 6 (stale digest sent).
// Criteria 1 and 2 pass.
const optouts = new Set();
const digests = new Set();

const KEYWORDS = new Set(["stop", "quit", "end", "revoke", "opt out", "cancel", "unsubscribe"]);
const normalise = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .replace(/\s+/g, " ");

const fmtCache = new Map();
function localMinute(date, zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return Number(p.hour) * 60 + Number(p.minute);
}

const refuse = (reason) => ({ sent: false, reason });

export async function trySend({ user, message, now }) {
  if (optouts.has(`${user.id}|${message.channel}`)) return refuse("The customer has turned off digest texts.");
  const minute = localMinute(now, user.timezone);
  if (minute < 480 || minute >= 1260) {
    return refuse("Digests go out only between 08:00 and 21:00 in the customer's local time.");
  }
  const key = `${user.id}|${message.id}`;
  if (digests.has(key)) return refuse("This digest was already sent to this customer.");
  digests.add(key);
  return { sent: true, reason: null };
}

export async function handleInbound({ userId, channel, text }) {
  if (!KEYWORDS.has(normalise(text))) return { revoked: false };
  optouts.add(`${userId}|${channel}`);
  return { revoked: true };
}

export async function optOut(userId, channel) {
  optouts.add(`${userId}|${channel}`);
}
