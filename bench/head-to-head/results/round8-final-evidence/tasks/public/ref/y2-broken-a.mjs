// Broken A for Y2. Mistake: the reasons are written for engineers, not for support staff.
//   They give UTC clock times instead of the user's local time, put ISO timestamps in the sentence, and write
//   "null" for a missing value. The decisions and sendAt values are correct.
// Expected to FAIL every criterion that reads a reason: 1, 2, 3, 4 and 6 (no local HH:MM, no today or tomorrow),
// and 5 (ISO text and the word null). Score 0/6 is the expected result for this mistake.
// Standalone; the decision logic is the reference's, with a different reason sentence.

const DAILY_LIMIT = 3;

const fmtCache = new Map();
function wall(ms, tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute) };
}
const pad = (n) => String(n).padStart(2, "0");
const minutesOf = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function offsetAt(ms, tz) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000;
}
function instantOf(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}
function nextLocal(ms, tz, h, mi) {
  const w = wall(ms, tz);
  let t = instantOf(w.y, w.mo, w.d, h, mi, tz);
  if (t <= ms) {
    const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
    t = instantOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, mi, tz);
  }
  return t;
}
const utcHM = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export function decide({ user, message, now }) {
  const ms = now.getTime();
  const tz = user.timezone;
  const here = wall(ms, tz);

  if (user.consent !== true) {
    return { send: false, sendAt: null, reason: `blocked: consent=null at ${utcHM(ms)} UTC` };
  }
  if (user.snoozedUntil && Date.parse(user.snoozedUntil) > ms) {
    const until = Date.parse(user.snoozedUntil);
    return { send: false, sendAt: new Date(until).toISOString(), reason: `snoozed until ${new Date(until).toISOString()}` };
  }
  if (user.quietHours) {
    const start = minutesOf(user.quietHours.start);
    const end = minutesOf(user.quietHours.end);
    const m = here.h * 60 + here.mi;
    const quiet = start < end ? m >= start && m < end : m >= start || m < end;
    if (quiet) {
      const at = nextLocal(ms, tz, Math.floor(end / 60), end % 60);
      return { send: false, sendAt: new Date(at).toISOString(), reason: `quiet hours, UTC ${utcHM(ms)}, sendAt ${new Date(at).toISOString()}` };
    }
  }
  if (user.sentToday >= DAILY_LIMIT) {
    const at = nextLocal(ms, tz, 0, 0);
    return { send: false, sendAt: new Date(at).toISOString(), reason: `daily limit, sentToday=${user.sentToday}, next=null` };
  }
  return { send: true, sendAt: null, reason: null };
}
