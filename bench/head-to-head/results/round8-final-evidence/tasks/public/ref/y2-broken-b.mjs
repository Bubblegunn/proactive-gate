// Broken B for Y2. Two plausible mistakes:
//   (1) precedence: the daily limit is checked first, so a user with no consent who has already had 3 messages today
//       gets the "daily limit" reason (criterion 1 fails);
//   (2) DST: the time until the next quiet-hours end or local midnight is computed as a number of minutes added to the
//       instant, using the wall-clock difference, so on the spring-forward day (2026-03-08, New York) the send time
//       is an hour late (criterion 2 fails).
// Reasons and everything else follow the reference, so criteria 3, 4 (daily limit at midnight), 5 and 6 can pass.
// Expected to FAIL criteria 1 and 2.

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
const hhmm = (h, mi) => `${pad(h)}:${pad(mi)}`;
const dayOf = (w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
const minutesOf = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

// Mistake 2: minutes to the target are taken from the wall clock and added as elapsed time (no zone rules).
function fixedNext(ms, tz, h, mi) {
  const w = wall(ms, tz);
  let delta = (h * 60 + mi - (w.h * 60 + w.mi) + 1440) % 1440;
  if (delta === 0) delta = 1440;
  return ms + delta * 60000;
}

function whenWord(sendMs, nowMs, tz) {
  const a = Date.parse(`${dayOf(wall(nowMs, tz))}T00:00:00Z`);
  const b = Date.parse(`${dayOf(wall(sendMs, tz))}T00:00:00Z`);
  const days = Math.round((b - a) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `on ${dayOf(wall(sendMs, tz))}`;
}

export function decide({ user, message, now }) {
  const ms = now.getTime();
  const tz = user.timezone;
  const here = wall(ms, tz);
  const nowHM = hhmm(here.h, here.mi);

  // Mistake 1: the cap is checked before consent and before the snooze.
  if (user.sentToday >= DAILY_LIMIT) {
    const at = fixedNext(ms, tz, 0, 0);
    return {
      send: false,
      sendAt: new Date(at).toISOString(),
      reason: `This message is held back because the daily limit of ${DAILY_LIMIT} messages has been reached (local time now is ${nowHM}), so it will go out at 00:00 ${whenWord(at, ms, tz)}.`,
    };
  }
  if (user.consent !== true) {
    return {
      send: false,
      sendAt: null,
      reason: `This message was not sent because the user has no consent to receive it (local time now is ${nowHM}).`,
    };
  }
  if (user.snoozedUntil && Date.parse(user.snoozedUntil) > ms) {
    const until = Date.parse(user.snoozedUntil);
    const w = wall(until, tz);
    return {
      send: false,
      sendAt: new Date(until).toISOString(),
      reason: `This message is held back because the user snoozed messages, so it will go out at ${hhmm(w.h, w.mi)} ${whenWord(until, ms, tz)} (local time now is ${nowHM}).`,
    };
  }
  if (user.quietHours) {
    const start = minutesOf(user.quietHours.start);
    const end = minutesOf(user.quietHours.end);
    const m = here.h * 60 + here.mi;
    const quiet = start < end ? m >= start && m < end : m >= start || m < end;
    if (quiet) {
      const at = fixedNext(ms, tz, Math.floor(end / 60), end % 60);
      const w = wall(at, tz);
      return {
        send: false,
        sendAt: new Date(at).toISOString(),
        reason: `This message is held back because of quiet hours from ${user.quietHours.start} to ${user.quietHours.end} (local time now is ${nowHM}), so it will go out at ${hhmm(w.h, w.mi)} ${whenWord(at, ms, tz)}.`,
      };
    }
  }
  return { send: true, sendAt: null, reason: null };
}
