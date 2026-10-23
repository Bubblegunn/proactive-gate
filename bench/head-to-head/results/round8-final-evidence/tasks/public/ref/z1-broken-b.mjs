// Broken B for Z1 (a plausible mistake set). Standalone: node builtins only.
// The consent, zone and hour rules are correct, but:
//   - all state lives in this process's memory (STATE_DIR is never used), so opt-outs and sends are lost in a new process;
//   - the check-in cap is a read-then-write counter with an await between the read and the write (a race);
//   - dismissals are counted across all types, so a check-in dismissal also silences a tip.
// Expected to FAIL criteria 2 (opt-out does not survive a new process), 4 (cap across processes) and 5 (tip silenced).
// Criteria 1, 3 and 6 pass.

const DISMISS_LIMIT = 3;
const optouts = new Set();
const dismissals = [];
const sends = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fmtCache = new Map();
function localParts(date, zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }),
    );
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function validZone(z) {
  if (typeof z !== "string" || z.length === 0) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

function usableZone(user) {
  return validZone(user.deviceTimezone) ?? (user.timezone === "UTC" ? null : validZone(user.timezone));
}

const refuse = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags }) {
  if (!flags || flags.proactiveEnabled !== true) return refuse("Proactive messages are switched off right now.");
  const type = candidate.type;
  if (optouts.has(`${user.id}|${type}`)) return refuse("The user switched this kind of notification off.");
  if (dismissals.filter((d) => d.user === user.id).length >= DISMISS_LIMIT) {
    return refuse("The user dismissed notifications several times, so they are paused.");
  }
  const consents = user.consents && typeof user.consents === "object" ? user.consents : {};
  if (consents.marketing !== true) return refuse("The user has not agreed to receive marketing messages.");
  const zone = usableZone(user);
  if (!zone) return refuse("No usable time zone is known for this user, so nothing is sent.");
  const local = localParts(now, zone);
  if (local.hour < 8 || local.hour >= 21) return refuse("It is outside the 08:00 to 21:00 window in the user's local time.");
  if (type === "checkin") {
    const used = sends.filter((s) => s.user === user.id && s.type === "checkin" && s.day === local.day).length;
    await sleep(5);
    if (used >= 1) return refuse("The daily check-in was already sent today for this user.");
  }
  sends.push({ user: user.id, type, day: local.day });
  return { send: true, reason: null };
}

export async function recordDismissal(userId, type, now) {
  dismissals.push({ user: userId, type, at: now });
}

export async function optOut(userId, type) {
  optouts.add(`${userId}|${type}`);
}
