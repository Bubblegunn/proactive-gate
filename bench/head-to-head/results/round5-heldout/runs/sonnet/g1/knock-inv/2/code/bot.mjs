// SMS send gate for a US retail app. Pure function: no I/O, no server time zone.
//
// Rules applied, in this order. The first rule that fails sets the reason code.
//
//  1. invalid_input, invalid_kind, invalid_phone, empty_body
//     Fail closed on malformed input. Phone must be a US/Canada +1 E.164 number.
//  2. opted_out (marketing only)
//     Customer replied STOP. 47 CFR 64.1200(a)(10) lets a called party revoke consent
//     by any reasonable means, and CTIA requires STOP to end the program. The
//     regulation allows up to 10 business days to honor it; this gate honors it at once.
//     Any non-null optedOutAt counts, even a value we cannot parse.
//  3. no_marketing_consent (marketing only)
//     47 CFR 64.1200(a)(2): an autodialed or prerecorded telemarketing text needs
//     prior express WRITTEN consent. marketingConsent must be exactly true.
//  4. quiet_hours (marketing only)
//     47 CFR 64.1200(c)(1): no telemarketing before 8 a.m. or after 9 p.m. at the
//     called party's location. We use the customer's home timeZone and allow
//     08:00:00 through 20:59:59 local time. An unknown time zone fails closed
//     (invalid_time_zone).
//  5. missing_opt_out_instructions (marketing only)
//     CTIA Messaging Principles: marketing texts must tell the customer how to opt
//     out. The body must contain a STOP instruction.
//
// Transactional texts (login codes, delivery updates the customer triggered) are
// not telemarketing. They skip rules 2-5, so a login code can go at 3 a.m. and after
// a STOP reply to marketing. See the notes in the hand-off about this decision.

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first blocked local hour

const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_INSTRUCTION = /\bSTOP\b/i;

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

function localHour(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) ? hour : null;
  } catch {
    return null; // RangeError for an unknown IANA zone
  }
}

export function checkSms(message, now) {
  if (!message || typeof message !== "object" || !message.to || typeof message.to !== "object") {
    return block("invalid_input");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_input");

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return block("invalid_phone");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");

  if (kind === "transactional") return ALLOW;

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  if (typeof to.timeZone !== "string" || to.timeZone === "") return block("invalid_time_zone");
  const hour = localHour(now, to.timeZone);
  if (hour === null) return block("invalid_time_zone");
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return block("quiet_hours");

  if (!STOP_INSTRUCTION.test(body)) return block("missing_opt_out_instructions");

  return ALLOW;
}
