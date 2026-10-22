// Reference for H1 decide(). Standalone: node builtins only.
// Local clock comes from Intl; the hold instant is the first minute after now whose local clock reads the target.
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

  const reasons = [];
  const opens = [];
  if (quiet) {
    reasons.push("It is within quiet hours for this customer.");
    opens.push(nextLocal(ms, tz, toMin(user.quietHours.end)));
  }
  if (legal) {
    reasons.push("Under 47 CFR 64.1200, SMS to a US recipient cannot be sent before 08:00 or from 21:00 local time.");
    opens.push(nextLocal(ms, tz, LEGAL_OPEN));
  }
  const holdUntil = opens.includes(null) ? null : new Date(Math.max(...opens)).toISOString();
  return { send: false, holdUntil, reason: reasons.join(" ") + " It is held until the moment given as holdUntil." };
}
