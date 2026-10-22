// SMS send gate. checkSms(message, now) -> { allowed, reason }.
// Pure and synchronous: no I/O, no dependence on the server's time zone.
//
// Rules, in the order they are checked. The first rule that fails gives the reason code.
//
//  Both kinds
//   invalid_kind          kind is not "marketing" or "transactional". Fail closed.
//   invalid_phone         `to.phone` is not a US/Canada NANP number in E.164 (+1NXXNXXXXXX).
//   empty_body            body is empty or only whitespace.
//
//  Marketing only
//   no_marketing_consent  47 CFR 64.1200(a)(2): an autodialed or AI-triggered marketing text needs the
//                         recipient's prior express written consent. Only `marketingConsent === true`
//                         counts; missing or any other value blocks.
//   opted_out             The customer replied STOP. 47 CFR 64.1200(a)(10) (revocation of consent in any
//                         reasonable manner) and CTIA principles: stop marketing texts. Applies from the
//                         moment of `optedOutAt` (a future timestamp is not yet in effect). An
//                         unparseable `optedOutAt` blocks (fail closed).
//   invalid_time_zone     Cannot work out the recipient's local time, so the calling-hours rule cannot
//                         be checked. Fail closed.
//   quiet_hours           47 CFR 64.1200(c)(1): no telephone solicitation before 8 a.m. or after 9 p.m.
//                         local time at the called party's location. We use the home `timeZone` from the
//                         profile as the called party's location. Allowed window: 08:00:00 up to, not
//                         including, 21:00:00.
//   missing_opt_out_notice  CTIA Messaging Principles: marketing texts must tell the customer how to opt
//                         out. The body must contain the word STOP (e.g. "Reply STOP to opt out").
//
//  Transactional
//   Texts the customer triggered (login code, delivery update) are not telephone solicitations, so the
//   calling-hours rule, the marketing consent flag and the marketing opt-out do not apply to them.
//   Assumption for the lawyers: a STOP reply is an opt-out from marketing; it does not block a text the
//   customer asks for by acting in the app. Do not use "transactional" for anything with promotional content.

const MARKETING_START_HOUR = 8; // inclusive
const MARKETING_END_HOUR = 21; // exclusive

const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_WORD = /\bSTOP\b/i;

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

// Local seconds since midnight in `timeZone` at `now`, or null if the zone is not valid.
function localSecondsOfDay(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return get("hour") * 3600 + get("minute") * 60 + get("second");
  } catch {
    return null;
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("checkSms: `now` must be a valid Date");
  }

  const kind = message?.kind;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");

  const to = message.to ?? {};
  if (typeof to.phone !== "string" || !NANP_E164.test(to.phone)) return block("invalid_phone");
  if (typeof message.body !== "string" || message.body.trim() === "") return block("empty_body");

  if (kind === "transactional") return ALLOW;

  if (to.marketingConsent !== true) return block("no_marketing_consent");

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    const optedOut = new Date(to.optedOutAt);
    if (typeof to.optedOutAt !== "string" || Number.isNaN(optedOut.getTime())) return block("opted_out");
    if (optedOut.getTime() <= now.getTime()) return block("opted_out");
  }

  const seconds = localSecondsOfDay(now, to.timeZone);
  if (seconds === null) return block("invalid_time_zone");
  if (seconds < MARKETING_START_HOUR * 3600 || seconds >= MARKETING_END_HOUR * 3600) {
    return block("quiet_hours");
  }

  if (!STOP_WORD.test(message.body)) return block("missing_opt_out_notice");

  return ALLOW;
}
