// SMS gate. Decides whether a text may go out now. Sends nothing.
//
// Rules, in the order they are checked:
//   transactional                -> allowed (the customer triggered it; not a marketing
//                                   solicitation under 47 CFR 64.1200)
//   marketing:
//     1. opted_out               -> optedOutAt is set (STOP honored, 64.1200(a)(10); CTIA)
//     2. no_marketing_consent    -> marketingConsent is not exactly true
//                                   (prior express written consent, 64.1200(a)(2))
//     3. invalid_time_zone       -> zone missing or not an IANA zone: unknown, so held
//     4. quiet_hours             -> recipient local time outside 08:00 (incl.) to
//                                   21:00 (excl.) (64.1200(c)(1))
// Any other kind is held as unknown_kind.

const QUIET_START_MINUTE = 8 * 60; // 08:00 local, inclusive
const QUIET_END_MINUTE = 21 * 60; // 21:00 local, exclusive

function localMinuteOfDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

const block = (reason) => ({ allowed: false, reason });

export function checkSms(message, now) {
  const kind = message?.kind;
  if (kind === "transactional") return { allowed: true, reason: null };
  if (kind !== "marketing") return block("unknown_kind");

  const to = message.to ?? {};

  // Opt-out beats every other rule. Any recorded value means the customer said STOP.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined && to.optedOutAt !== "") {
    return block("opted_out");
  }

  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const zone = to.timeZone;
  if (typeof zone !== "string" || zone === "" || !(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block("invalid_time_zone");
  }
  let minute;
  try {
    minute = localMinuteOfDay(now, zone);
  } catch {
    return block("invalid_time_zone");
  }
  if (minute < QUIET_START_MINUTE || minute >= QUIET_END_MINUTE) return block("quiet_hours");

  return { allowed: true, reason: null };
}
