// Broken B for H1: the legal window and quiet hours both decide whether a message is held, but the hold
// time and the reason come from only ONE rule: the quiet-hours end if quiet hours apply, otherwise the legal
// opening. The later of the two is never taken.
// Expected FAILS: 1 (NY normal SMS at 01:00Z must name both rules), 3 (22-10 at 11:00Z has the right instant
// but no 47 CFR text; 22-06 at 09:00Z gives 10:00Z instead of 12:00Z).
// Expected PASSES: 2 (critical SMS is legal-only), 4 (no case where both rules apply), 5 and 6.
// Standalone: node builtins only.
const MIN = 60000;
const LEGAL_OPEN = 8 * 60;
const LEGAL_CLOSE = 21 * 60;

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }));
  }
  return fmts.get(tz);
}

function validZone(tz) {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function localMinute(ms, tz) {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour").value);
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

const toMin = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

function inQuiet(m, q) {
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

function nextLocal(ms, tz, target) {
  let t = (Math.floor(ms / MIN) + 1) * MIN;
  for (let i = 0; i < 3 * 24 * 60; i++, t += MIN) {
    if (localMinute(t, tz) === target) return t;
  }
  return null;
}

export async function decide({ user, message, now }) {
  const ms = now.getTime();
  const tz = user.timezone;
  if (!validZone(tz)) {
    return { send: false, holdUntil: null, reason: "This customer has no valid time zone, so the message cannot be timed and was not sent." };
  }
  const m = localMinute(ms, tz);
  const quiet = message.priority !== "critical" && !!user.quietHours && inQuiet(m, user.quietHours);
  const legal = message.channel === "sms" && user.country === "US" && (m < LEGAL_OPEN || m >= LEGAL_CLOSE);
  if (!quiet && !legal) return { send: true, holdUntil: null, reason: "The message can go out now." };

  // Mistake: the hold time and the reason follow one rule only.
  if (quiet) {
    const t = nextLocal(ms, tz, toMin(user.quietHours.end));
    return { send: false, holdUntil: t === null ? null : new Date(t).toISOString(), reason: "It is within quiet hours for this customer. It is held until the moment given as holdUntil." };
  }
  const t = nextLocal(ms, tz, LEGAL_OPEN);
  return { send: false, holdUntil: t === null ? null : new Date(t).toISOString(), reason: "Under 47 CFR 64.1200, SMS to a US recipient cannot be sent before 08:00 or from 21:00 local time. It is held until the moment given as holdUntil." };
}
