// SMS send gate. checkSms(message, now) -> { allowed, reason }.
//
// Rules applied (US, federal):
//
// Both kinds
//   invalid_message / invalid_now / invalid_kind  input is malformed; fail closed.
//   invalid_phone_number / non_us_number          destination must be a valid +1 NANP number.
//   empty_body                                    nothing to send.
//
// Transactional (login codes, delivery updates the customer asked for)
//   Not telemarketing under 47 CFR 64.1200, so no marketing consent, no
//   calling-hours limit and no STOP-based block. The customer's own action in
//   the app triggers the text and supplies the number for it. Assumption: the
//   caller only uses kind "transactional" for texts with no promotional
//   content. A text that mixes in a promotion is a marketing text; send it as
//   kind "marketing".
//
// Marketing (sales, coupons, back-in-stock nudges, sent by the AI agent)
//   opted_out / invalid_opted_out_at   47 CFR 64.1200(a)(10): consent is revoked by any
//                                      reasonable means, STOP included. We stop at once
//                                      (the rule allows up to 10 business days). A non-null
//                                      optedOutAt that cannot be parsed blocks the text.
//   no_marketing_consent               47 CFR 64.1200(a)(2): autodialed or AI-driven
//                                      telemarketing texts need prior express written
//                                      consent. We only know the sign-up box value; it must
//                                      be exactly true.
//   invalid_time_zone                  local time cannot be found, so the calling-hours rule
//                                      cannot be checked; fail closed.
//   outside_calling_hours              47 CFR 64.1200(c)(1): no telephone solicitation before
//                                      8 a.m. or after 9 p.m. at the called party's location.
//                                      Allowed window is 08:00:00 up to, not including,
//                                      21:00:00 in the customer's time zone.
//   missing_opt_out_instructions       CTIA Messaging Principles: marketing texts must give a
//                                      clear way to opt out. The body must contain the word
//                                      STOP (for example "Reply STOP to opt out").
//
// Not checked (needs data this function does not get): National/State Do-Not-Call
// registries (64.1200(c)(2)), state "mini-TCPA" hours (for example Florida and
// Oklahoma 8 a.m.-8 p.m.), the customer's real location when away from home,
// consent not being a condition of purchase, sender identification in the body,
// and carrier content/frequency limits.

const US_PHONE = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/;
const E164 = /^\+[1-9]\d{1,14}$/;
const OPT_OUT_WORD = /\bstop\b/i;

const CALLING_HOURS_START = 8; // inclusive, local hour
const CALLING_HOURS_END = 21; // exclusive, local hour

const block = (reason) => ({ allowed: false, reason });
const ALLOW = { allowed: true, reason: null };

function localHour(date, timeZone) {
  // Throws RangeError for an unknown IANA zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour");
  return Number(hour.value);
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block("invalid_now");
  }
  if (message === null || typeof message !== "object" || message.to === null || typeof message.to !== "object") {
    return block("invalid_message");
  }
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") {
    return block("invalid_kind");
  }

  if (typeof to.phone !== "string" || !E164.test(to.phone)) {
    return block("invalid_phone_number");
  }
  if (!to.phone.startsWith("+1")) {
    return block("non_us_number");
  }
  if (!US_PHONE.test(to.phone)) {
    return block("invalid_phone_number");
  }

  if (typeof body !== "string" || body.trim() === "") {
    return block("empty_body");
  }

  if (kind === "transactional") {
    return ALLOW;
  }

  // Marketing.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (typeof to.optedOutAt !== "string" || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block("invalid_opted_out_at");
    }
    return block("opted_out");
  }

  if (to.marketingConsent !== true) {
    return block("no_marketing_consent");
  }

  let hour;
  try {
    if (typeof to.timeZone !== "string" || to.timeZone === "") throw new RangeError("timeZone");
    hour = localHour(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (hour < CALLING_HOURS_START || hour >= CALLING_HOURS_END) {
    return block("outside_calling_hours");
  }

  if (!OPT_OUT_WORD.test(body)) {
    return block("missing_opt_out_instructions");
  }

  return ALLOW;
}
