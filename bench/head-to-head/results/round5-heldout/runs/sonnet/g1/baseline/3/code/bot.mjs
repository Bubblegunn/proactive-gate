// SMS send gate for US customers.
//
// checkSms(message, now) -> { allowed, reason }
// Checks run in this order; the first failing rule decides the reason code.
//
// Input validation (fail closed, applies to both kinds):
//   invalid_message, invalid_kind, invalid_now, invalid_phone, empty_body
//
// Marketing only (47 CFR 64.1200 TCPA rules, CTIA messaging principles):
//   opted_out              Customer replied STOP. Revoked consent must be honored
//                          (64.1200(a)(10); CTIA: STOP ends the program). Applied
//                          immediately, which is stricter than the FCC's 10-business-day
//                          limit. An opt-out date that is unparseable or in the future
//                          also blocks (fail closed, as invalid_opt_out_date for unparseable).
//   no_marketing_consent   Marketing texts sent with an autodialer / AI agent need the
//                          recipient's prior express written consent (64.1200(a)(2)).
//                          Only marketingConsent === true counts.
//   invalid_time_zone      Quiet-hours check needs a valid IANA zone; fail closed.
//   quiet_hours            Telephone solicitations may not be made before 8 a.m. or after
//                          9 p.m. at the called party's location (64.1200(c)(1)). Allowed
//                          window is 08:00:00 to 20:59:59 local time. The zone comes from
//                          the profile, never from the server.
//
// Transactional texts (login codes, delivery updates the customer triggered) are not
// telemarketing: no marketing consent, quiet hours or marketing opt-out applies.
//
// Not covered because the input has no data for it (callers must handle these):
//   - National/state Do-Not-Call lists (64.1200(c)(2), (d)) and stricter state hours
//     (e.g. FL, OK, TX Sunday rules).
//   - Whether a "transactional" body contains promotional content (that would make it
//     marketing). The caller must set `kind` honestly.
//   - CTIA content rules: sender identification and STOP/HELP instructions in the
//     first message and periodically; message frequency/rates disclosure.
//   - Re-opt-in after STOP: there is no consent date, so an opt-out always wins until
//     the caller clears optedOutAt.

const BLOCK = (reason) => ({ allowed: false, reason });
const ALLOW = { allowed: true, reason: null };

// +1, area code and exchange start with 2-9 (NANP).
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const QUIET_START_HOUR = 8; // inclusive
const QUIET_END_HOUR = 21; // exclusive: 9 p.m. itself is already too late

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
    return null; // RangeError for an invalid time zone
  }
}

export function checkSms(message, now) {
  if (message === null || typeof message !== "object") return BLOCK("invalid_message");
  if (message.kind !== "marketing" && message.kind !== "transactional") {
    return BLOCK("invalid_kind");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return BLOCK("invalid_now");

  const to = message.to;
  if (to === null || typeof to !== "object") return BLOCK("invalid_message");
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return BLOCK("invalid_phone");
  if (typeof message.body !== "string" || message.body.trim() === "") return BLOCK("empty_body");

  if (message.kind === "transactional") return ALLOW;

  // Marketing from here on.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    const optedOut = typeof to.optedOutAt === "string" ? Date.parse(to.optedOutAt) : NaN;
    if (Number.isNaN(optedOut)) return BLOCK("invalid_opt_out_date");
    return BLOCK("opted_out");
  }

  if (to.marketingConsent !== true) return BLOCK("no_marketing_consent");

  const hour = typeof to.timeZone === "string" ? localHour(now, to.timeZone) : null;
  if (hour === null) return BLOCK("invalid_time_zone");
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return BLOCK("quiet_hours");

  return ALLOW;
}
