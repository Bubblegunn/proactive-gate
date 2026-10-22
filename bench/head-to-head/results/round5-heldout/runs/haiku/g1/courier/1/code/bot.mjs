// SMS send gate for US recipients.
//
// checkSms(message, now) decides whether one text may go to the SMS provider
// right now. It sends nothing. It returns { allowed, reason }; when allowed is
// false, reason is the snake_case code of the first rule that blocked the text.
//
// Rules, in the order they are checked:
//   1. Input validity (fail closed): kind, body, US phone, time zone, now.
//   2. Opt-out (STOP): any recorded opt-out blocks both kinds of text.
//      CTIA: a STOP ends the program. FCC 47 CFR 64.1200(a)(10): consent
//      revocation must be honored (the rule sets a 10 business day limit;
//      this gate blocks immediately, which is stricter).
//   3. Transactional text: allowed. It was triggered by the customer, so no
//      marketing consent is needed and quiet hours do not apply.
//   4. Marketing text:
//      a. Prior express written consent: marketingConsent must be true.
//         47 CFR 64.1200(a)(2) (telemarketing texts to wireless numbers).
//      b. Opt-out instructions in the body (CTIA Messaging Principles).
//      c. Quiet hours: 8:00 to 20:59 at the customer's local time, computed
//         from the customer's IANA time zone. 47 CFR 64.1200(c)(1).
//
// The server's own time zone is never used: local time comes from Intl with
// an explicit timeZone.

const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const QUIET_HOURS_START = 8; // inclusive, local hour
const QUIET_HOURS_END = 21; // exclusive, local hour
const STOP_WORD = /\bSTOP\b/i;

const allowed = () => ({ allowed: true, reason: null });
const blocked = (reason) => ({ allowed: false, reason });

function localHour(now, timeZone) {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((p) => p.type === "hour");
  return Number(part.value);
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return blocked("invalid_now");
  }
  if (message == null || typeof message !== "object") {
    return blocked("invalid_message");
  }

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") {
    return blocked("invalid_kind");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    return blocked("empty_body");
  }
  if (to == null || typeof to !== "object") {
    return blocked("invalid_recipient");
  }
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) {
    return blocked("invalid_phone");
  }

  // Rule 2: STOP applies to every kind of text.
  if (to.optedOutAt != null) {
    if (Number.isNaN(Date.parse(to.optedOutAt))) {
      return blocked("invalid_opt_out_timestamp");
    }
    return blocked("opted_out");
  }

  // Rule 3: customer-triggered transactional text.
  if (kind === "transactional") {
    return allowed();
  }

  // Rule 4a: prior express written consent for marketing.
  if (to.marketingConsent !== true) {
    return blocked("marketing_consent_missing");
  }

  // Rule 4b: marketing text must tell the customer how to opt out.
  if (!STOP_WORD.test(body)) {
    return blocked("marketing_missing_opt_out_instructions");
  }

  // Rule 4c: telemarketing quiet hours in the customer's local time.
  if (!isValidTimeZone(to.timeZone)) {
    return blocked("invalid_time_zone");
  }
  const hour = localHour(now, to.timeZone);
  if (hour < QUIET_HOURS_START || hour >= QUIET_HOURS_END) {
    return blocked("telemarketing_quiet_hours");
  }

  return allowed();
}
