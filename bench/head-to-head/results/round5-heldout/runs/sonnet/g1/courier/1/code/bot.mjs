// SMS send gate for US recipients. Pure and synchronous: it sends nothing.
//
// Rules, in the order they are checked. The first rule that fails gives the reason code.
//
//  Both kinds
//   invalid_message      message, kind, body or recipient is missing or malformed
//   invalid_now          `now` is not a valid Date
//   invalid_phone        `to.phone` is not a valid US/NANP number in E.164 (+1NXXNXXXXXX)
//   empty_body           body is empty or only whitespace
//
//  Marketing only (autodialed or AI-initiated telemarketing text)
//   opted_out                   customer replied STOP (optedOutAt is set). 47 CFR 64.1200(a)(10)
//                               requires honoring a revocation; CTIA requires STOP to end the
//                               program. We block at once, with no 10-business-day grace period.
//   no_marketing_consent        no prior express written consent (marketingConsent !== true).
//                               47 CFR 64.1200(a)(2), (f)(9).
//   invalid_time_zone           time zone is not a valid IANA zone, so the local hour is unknown.
//                               We fail closed.
//   quiet_hours                 recipient's local time is before 8:00 or at/after 21:00.
//                               47 CFR 64.1200(c)(1). The rule says "after 9 p.m."; we also
//                               block 21:00:00 exactly, to stay on the safe side.
//   missing_opt_out_instructions body does not tell the customer to reply STOP.
//                               CTIA Messaging Principles: opt-out must be offered.
//
//  Transactional (customer-triggered: login codes, delivery updates)
//   Not subject to the marketing consent, quiet-hours and opt-out-text rules. They are
//   informational messages the customer asked for. After STOP they are still allowed;
//   see the notes in the reply to the team.

const MARKETING = "marketing";
const TRANSACTIONAL = "transactional";

// NANP: +1, area code NXX and exchange NXX where N is 2-9.
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{2}\d{4}$/;
const STOP_WORD = /\bSTOP\b/i;

const QUIET_END_HOUR = 8; // first allowed local hour
const QUIET_START_HOUR = 21; // first blocked local hour in the evening

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

// Local hour (0-23) in `timeZone` at instant `now`, or null if the zone is invalid.
function localHour(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) ? hour : null;
  } catch {
    return null;
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");

  const to = message?.to;
  if (
    message === null ||
    typeof message !== "object" ||
    (message.kind !== MARKETING && message.kind !== TRANSACTIONAL) ||
    typeof message.body !== "string" ||
    to === null ||
    typeof to !== "object"
  ) {
    return block("invalid_message");
  }

  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return block("invalid_phone");
  if (message.body.trim() === "") return block("empty_body");

  if (message.kind === TRANSACTIONAL) return ALLOW;

  // Marketing. Any non-null optedOutAt counts as opted out, even if it is unparseable
  // or in the future: fail closed.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const hour = localHour(now, to.timeZone);
  if (hour === null) return block("invalid_time_zone");
  if (hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR) return block("quiet_hours");

  if (!STOP_WORD.test(message.body)) return block("missing_opt_out_instructions");

  return ALLOW;
}
