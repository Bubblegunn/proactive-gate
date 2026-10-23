// Reference for Y2: decide({ user, message, now }). Standalone, node builtins only. Synchronous.
// Rules, first that applies wins: no consent; snoozed until after now; quiet hours (local); 3 per local day.
// Local clocks come from Intl.DateTimeFormat in the user's zone, and every "next local time" is found by asking the
// zone for the instant whose wall clock reads that time, so DST days are right without any fixed offset.

const DAILY_LIMIT = 3;

const fmtCache = new Map();
function wall(ms, tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute) };
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (h, mi) => `${pad(h)}:${pad(mi)}`;
const dayOf = (w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
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
// First instant after ms at which the local clock reads h:mi.
function nextLocal(ms, tz, h, mi) {
  const w = wall(ms, tz);
  let t = instantOf(w.y, w.mo, w.d, h, mi, tz);
  if (t <= ms) {
    const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
    t = instantOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, mi, tz);
  }
  return t;
}

// The word that tells a reader how far away the send time is.
function whenWord(sendMs, nowMs, tz) {
  const a = Date.parse(`${dayOf(wall(nowMs, tz))}T00:00:00Z`);
  const b = Date.parse(`${dayOf(wall(sendMs, tz))}T00:00:00Z`);
  const days = Math.round((b - a) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `on ${dayOf(wall(sendMs, tz))}`;
}

const blocked = (send, sendAt, reason) => ({ send, sendAt, reason });

export function decide({ user, message, now }) {
  const ms = now.getTime();
  const tz = user.timezone;
  const here = wall(ms, tz);
  const nowHM = hhmm(here.h, here.mi);

  // 1. No consent: never sent later, so no time.
  if (user.consent !== true) {
    return blocked(
      false,
      null,
      `This message was not sent because the user has no consent to receive it (local time now is ${nowHM}).`,
    );
  }

  // 2. Snoozed until a time after now.
  if (user.snoozedUntil) {
    const until = Date.parse(user.snoozedUntil);
    if (until > ms) {
      const w = wall(until, tz);
      return blocked(
        false,
        new Date(until).toISOString(),
        `This message is held back because the user snoozed messages, so it will go out at ${hhmm(w.h, w.mi)} ${whenWord(until, ms, tz)} (local time now is ${nowHM}).`,
      );
    }
  }

  // 3. Quiet hours, which may cross midnight.
  if (user.quietHours) {
    const start = minutesOf(user.quietHours.start);
    const end = minutesOf(user.quietHours.end);
    const m = here.h * 60 + here.mi;
    const quiet = start < end ? m >= start && m < end : m >= start || m < end;
    if (quiet) {
      const at = nextLocal(ms, tz, Math.floor(end / 60), end % 60);
      const w = wall(at, tz);
      return blocked(
        false,
        new Date(at).toISOString(),
        `This message is held back because of quiet hours from ${user.quietHours.start} to ${user.quietHours.end} (local time now is ${nowHM}), so it will go out at ${hhmm(w.h, w.mi)} ${whenWord(at, ms, tz)}.`,
      );
    }
  }

  // 4. Daily limit: the next local midnight.
  if (user.sentToday >= DAILY_LIMIT) {
    const at = nextLocal(ms, tz, 0, 0);
    return blocked(
      false,
      new Date(at).toISOString(),
      `This message is held back because the daily limit of ${DAILY_LIMIT} messages has been reached (local time now is ${nowHM}), so it will go out at 00:00 ${whenWord(at, ms, tz)}.`,
    );
  }

  return { send: true, sendAt: null, reason: null };
}
