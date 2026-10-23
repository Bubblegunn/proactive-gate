// Broken A for H1: uses ONE fixed UTC offset per zone, taken at 2026-01-01T12:00Z, for every date.
// The mistake ignores daylight saving time. Expected FAILS: 1 (June NY cases), 2 (DST days and June boundary),
// 3 (June later-of cases), 4 (June NY email and Istanbul cases). Expected PASSES: 5 (Kolkata and Kathmandu have
// no DST, so a fixed offset is right) and 6 (invalid zones are still rejected, and the Paris case sends).
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

function localMinuteNow(ms, tz) {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour").value);
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

const offsets = new Map();
function fixedOffset(tz) {
  if (!offsets.has(tz)) {
    let d = localMinuteNow(Date.UTC(2026, 0, 1, 12), tz) - 720;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    offsets.set(tz, d);
  }
  return offsets.get(tz);
}

const clock = (ms, off) => (((Math.floor(ms / MIN) + off) % 1440) + 1440) % 1440;
const toMin = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function inQuiet(m, q) {
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}
// Arithmetic on the fixed offset: first minute after ms whose clock reads target.
function nextClock(ms, off, target) {
  const now = clock(ms, off);
  let diff = (target - now + 1440) % 1440;
  if (diff === 0) diff = 1440;
  return (Math.floor(ms / MIN) + diff) * MIN;
}

export async function decide({ user, message, now }) {
  const ms = now.getTime();
  const tz = user.timezone;
  if (!validZone(tz)) {
    return { send: false, holdUntil: null, reason: "This customer has no valid time zone, so the message cannot be timed and was not sent." };
  }
  const off = fixedOffset(tz);
  const m = clock(ms, off);
  const quiet = message.priority !== "critical" && !!user.quietHours && inQuiet(m, user.quietHours);
  const legal = message.channel === "sms" && user.country === "US" && (m < LEGAL_OPEN || m >= LEGAL_CLOSE);
  if (!quiet && !legal) return { send: true, holdUntil: null, reason: "The message can go out now." };

  const reasons = [];
  const opens = [];
  if (quiet) {
    reasons.push("It is within quiet hours for this customer.");
    opens.push(nextClock(ms, off, toMin(user.quietHours.end)));
  }
  if (legal) {
    reasons.push("Under 47 CFR 64.1200, SMS to a US recipient cannot be sent before 08:00 or from 21:00 local time.");
    opens.push(nextClock(ms, off, LEGAL_OPEN));
  }
  const holdUntil = new Date(Math.max(...opens)).toISOString();
  return { send: false, holdUntil, reason: reasons.join(" ") + " It is held until the moment given as holdUntil." };
}
