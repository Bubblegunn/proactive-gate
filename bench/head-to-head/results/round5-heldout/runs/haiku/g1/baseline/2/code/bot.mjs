// SMS send gate for US customers.
//
// checkSms(message, now) decides whether one text may go to the SMS provider
// right now. It sends nothing. It returns { allowed, reason }. When allowed is
// false, reason is the snake_case code of the first rule that blocked the text.
//
// Rules, in the order they are checked:
//   1. Input validation (fail closed): now, kind, body, phone, time zone,
//      opt-out timestamp.
//   2. opted_out: the customer replied STOP. Applies to marketing and
//      transactional texts. 47 CFR 64.1200(a)(10) (revocation of consent,
//      honored within 10 business days; this gate blocks at once) and CTIA
//      Messaging Principles (STOP ends the program).
//   3. Marketing only:
//      a. no_marketing_consent: the customer did not give prior express
//         written consent (sign-up box ticked). 47 CFR 64.1200(c)(2) and
//         (a)(2).
//      b. missing_opt_out_language: the body does not tell the customer how to
//         opt out (the word STOP). CTIA Messaging Principles, opt-out
//         requirement.
//      c. quiet_hours: local time at the customer's home is before 08:00 or
//         at/after 21:00. 47 CFR 64.1200(c)(1).
//   4. Transactional texts (customer-triggered): no consent check and no quiet
//      hours check. They pass if none of the rules above blocked them.
//
// The server time zone is never read. All local-time math uses the customer's
// IANA time zone through Intl.

const MARKETING_START_HOUR = 8; // 08:00 local, inclusive
const MARKETING_END_HOUR = 21; // 21:00 local, exclusive

// US NANP number in E.164: +1, area code and exchange start with 2-9.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{2}\d{4}$/;

const allowed = () => ({ allowed: true, reason: null });
const blocked = (reason) => ({ allowed: false, reason });

// Returns the local hour (0-23) and minute in the given IANA zone, or null if
// the zone is unknown.
function localHourMinute(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour");
  const minute = get("minute");
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { hour, minute };
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return blocked("invalid_now");
  }

  const { kind, body, to } = message ?? {};
  if (kind !== "marketing" && kind !== "transactional") {
    return blocked("invalid_kind");
  }
  if (typeof body !== "string" || body.trim() === "") {
    return blocked("empty_body");
  }
  if (!to || typeof to !== "object") {
    return blocked("invalid_recipient");
  }
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) {
    return blocked("invalid_phone");
  }
  const clock = localHourMinute(now, to.timeZone);
  if (clock === null) {
    return blocked("invalid_time_zone");
  }

  // Rule 2: STOP blocks every text type from this sender.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    const optedOut = new Date(to.optedOutAt);
    if (Number.isNaN(optedOut.getTime())) {
      return blocked("invalid_opt_out_timestamp");
    }
    return blocked("opted_out");
  }

  if (kind === "transactional") {
    return allowed();
  }

  // Rule 3: marketing texts.
  if (to.marketingConsent !== true) {
    return blocked("no_marketing_consent");
  }
  if (!/\bSTOP\b/i.test(body)) {
    return blocked("missing_opt_out_language");
  }
  const minutesOfDay = clock.hour * 60 + clock.minute;
  if (
    minutesOfDay < MARKETING_START_HOUR * 60 ||
    minutesOfDay >= MARKETING_END_HOUR * 60
  ) {
    return blocked("quiet_hours");
  }

  return allowed();
}
