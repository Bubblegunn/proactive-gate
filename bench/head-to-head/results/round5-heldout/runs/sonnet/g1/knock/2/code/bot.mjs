// SMS send gate. checkSms(message, now) -> { allowed, reason }.
//
// Rules, in the order they are checked.
//
// Both kinds:
//   invalid_message        malformed input, or `now` is not a valid Date (fail closed)
//   invalid_phone_number   `to.phone` is not a US/NANP E.164 number (+1 and 10 digits)
//   empty_body             body is empty or whitespace
//
// Transactional (login codes, delivery updates the customer triggered):
//   Not a telephone solicitation under 47 CFR 64.1200, so the marketing consent,
//   opt-out and calling-hours rules do not apply. Customers still receive login
//   codes after STOP. ASSUMPTION for legal review: a STOP reply is read as
//   revoking marketing only.
//
// Marketing (sent by the AI agent on its own):
//   marketing_opted_out         the customer replied STOP (optedOutAt is set).
//                               CTIA: honor STOP. 47 CFR 64.1200(a)(10): honor
//                               revocation. Any non-null value blocks, even a future
//                               timestamp, because we cannot check when the reply came.
//   invalid_opt_out_timestamp   optedOutAt is set but unparseable; fail closed
//   no_marketing_consent        marketingConsent is not exactly true.
//                               47 CFR 64.1200(a)(2): prior express written consent
//                               for autodialed marketing texts. CTIA: opt-in required.
//   invalid_time_zone           timeZone is not a valid IANA zone; fail closed
//   quiet_hours                 customer's local time is before 08:00 or at/after
//                               21:00. 47 CFR 64.1200(c)(1). Local time comes from the
//                               profile's home zone, computed with Intl, so the server
//                               zone does not matter and DST is handled.
//
// Not enforced (needs data this function does not get): state laws that are stricter
// than the FCC rule (for example Florida and Oklahoma end at 8 p.m.), the CTIA
// requirement for opt-out/HELP wording in the first message and periodically, the
// customer's real location when away from home, frequency limits, and whether a
// "transactional" body contains promotion.

const KINDS = new Set(["marketing", "transactional"]);
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const FIRST_HOUR = 8; // inclusive
const LAST_HOUR = 21; // exclusive: nothing at or after 21:00

const block = (reason) => ({ allowed: false, reason });

function localHour(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour").value) % 24;
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_message");
  if (!message || typeof message !== "object" || !KINDS.has(message.kind)) {
    return block("invalid_message");
  }
  const { body, to } = message;
  if (typeof body !== "string" || !to || typeof to !== "object") return block("invalid_message");

  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) {
    return block("invalid_phone_number");
  }
  if (body.trim() === "") return block("empty_body");

  if (message.kind === "transactional") return { allowed: true, reason: null };

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (typeof to.optedOutAt !== "string" || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block("invalid_opt_out_timestamp");
    }
    return block("marketing_opted_out");
  }
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  let hour;
  try {
    hour = localHour(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (hour < FIRST_HOUR || hour >= LAST_HOUR) return block("quiet_hours");

  return { allowed: true, reason: null };
}
